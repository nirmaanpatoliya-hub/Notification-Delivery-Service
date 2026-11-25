/**
 * DakGhar (डाकघर) Notification Delivery Service - Outbox Dashboard (Screen 2)
 *
 * Responsibilities:
 * 1. Fetches and displays notifications ordered newest-first with cursor pagination (before_id).
 * 2. Displays global status counts on 4 summary cards, irrespective of active table filters.
 * 3. Supports multi-filter combinations (Status, Channel, Category) with localStorage persistence.
 * 4. Implements safe 2-second polling without overlapping requests, UI flickering, or viewport jumps.
 *    - Updates existing messages in place without wiping paginated older messages.
 *    - Detects and removes messages that stop matching active filters (e.g. pending -> sent).
 *    - Uses a floating "↑ N new messages" pill when the user is scrolled or inspecting rows.
 * 5. Provides accurate manual refresh feedback (success toast on success, error toast on failure).
 * 6. Converts table into stacked cards on mobile screens (down to 375px).
 * 7. Strictly uses textContent to ensure complete XSS output safety.
 */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // --- Configuration ---
  const POLL_INTERVAL_MS = 2000;
  const PAGE_LIMIT = 50;

  // --- State Variables ---
  const state = {
    filters: {
      status: '',
      channel: '',
      category: ''
    },
    autoRefresh: true,
    pollTimer: null,
    messages: [],            // Currently loaded messages list (includes paginated older messages)
    messageIdSet: new Set(), // Set of loaded message IDs to prevent duplicates
    oldestLoadedId: null,    // Cursor for pagination (lowest loaded ID)
    pendingNewMessages: [],  // Messages waiting to be prepended when user is reading
    isUserInteracting: false // User is scrolled down (>120px) or hovering table
  };

  // --- DOM Elements ---
  const countPending = document.getElementById('countPending');
  const countSending = document.getElementById('countSending');
  const countSent = document.getElementById('countSent');
  const countFailed = document.getElementById('countFailed');

  const cardPending = document.getElementById('cardPending');
  const cardSending = document.getElementById('cardSending');
  const cardSent = document.getElementById('cardSent');
  const cardFailed = document.getElementById('cardFailed');

  const filterStatus = document.getElementById('filterStatus');
  const filterChannel = document.getElementById('filterChannel');
  const filterCategory = document.getElementById('filterCategory');
  const clearFiltersBtn = document.getElementById('clearFiltersBtn');

  const autoRefreshSwitch = document.getElementById('autoRefreshSwitch');
  const autoRefreshLabel = document.getElementById('autoRefreshLabel');
  const refreshBtn = document.getElementById('refreshBtn');
  const refreshIcon = document.getElementById('refreshIcon');

  const newMessagesBanner = document.getElementById('newMessagesBanner');
  const newMessagesPill = document.getElementById('newMessagesPill');
  const newMessagesCountText = document.getElementById('newMessagesCountText');

  const messagesTableBody = document.getElementById('messagesTableBody');
  const tableLoadingSpinner = document.getElementById('tableLoadingSpinner');
  const emptyStateContainer = document.getElementById('emptyStateContainer');
  const tableStatusCount = document.getElementById('tableStatusCount');
  const tableWrapper = document.getElementById('tableWrapper');

  const loadOlderBtn = document.getElementById('loadOlderBtn');
  const loadOlderSpinner = document.getElementById('loadOlderSpinner');
  const loadOlderIcon = document.getElementById('loadOlderIcon');
  const loadOlderText = document.getElementById('loadOlderText');
  const allLoadedMsg = document.getElementById('allLoadedMsg');

  // --- Preference Management (localStorage for filters & refresh) ---

  function loadSavedPreferences() {
    const prefs = DakGhar.getPrefs();

    // Restore filters
    if (prefs.outboxFilters) {
      if (prefs.outboxFilters.status) {
        state.filters.status = prefs.outboxFilters.status;
        filterStatus.value = prefs.outboxFilters.status;
      }
      if (prefs.outboxFilters.channel) {
        state.filters.channel = prefs.outboxFilters.channel;
        filterChannel.value = prefs.outboxFilters.channel;
      }
      if (prefs.outboxFilters.category) {
        state.filters.category = prefs.outboxFilters.category;
        filterCategory.value = prefs.outboxFilters.category;
      }
    }

    // Restore auto-refresh state (defaults to true)
    if (prefs.autoRefresh !== undefined) {
      state.autoRefresh = Boolean(prefs.autoRefresh);
    }
    autoRefreshSwitch.checked = state.autoRefresh;
    updateAutoRefreshUI();
    updateCountCardsHighlight();
  }

  function savePreferences() {
    DakGhar.savePrefs({
      outboxFilters: Object.assign({}, state.filters),
      autoRefresh: state.autoRefresh
    });
  }

  // --- Count Cards UI Updates ---

  function updateCountCards(counts) {
    if (!counts) return;
    countPending.textContent = Number(counts.pending || 0).toLocaleString();
    countSending.textContent = Number(counts.sending || 0).toLocaleString();
    countSent.textContent = Number(counts.sent || 0).toLocaleString();
    countFailed.textContent = Number(counts.failed || 0).toLocaleString();
  }

  function updateCountCardsHighlight() {
    // Highlight the card that matches the active status filter
    cardPending.classList.toggle('active', state.filters.status === 'pending');
    cardSending.classList.toggle('active', state.filters.status === 'sending');
    cardSent.classList.toggle('active', state.filters.status === 'sent');
    cardFailed.classList.toggle('active', state.filters.status === 'failed');
  }

  // --- Auto-Refresh Controls ---

  function updateAutoRefreshUI() {
    if (state.autoRefresh) {
      autoRefreshLabel.textContent = 'Auto-refresh (2s)';
      autoRefreshSwitch.checked = true;
    } else {
      autoRefreshLabel.textContent = 'Auto-refresh Paused';
      autoRefreshSwitch.checked = false;
    }
  }

  function startPolling() {
    stopPolling();
    if (!state.autoRefresh) return;

    state.pollTimer = setInterval(() => {
      checkUserInteraction();
      pollLatestMessages();
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function checkUserInteraction() {
    // User is interacting if scrolled down > 120px or mouse is hovering over the table
    const isScrolled = window.scrollY > 120;
    const isHovering = tableWrapper && tableWrapper.matches(':hover');
    state.isUserInteracting = isScrolled || isHovering;
  }

  // --- Concurrency & Lock Coordination ---
  let currentLock = null; // Holds { lockId, promise, release } or null
  let nextLockId = 1;

  /**
   * Captures the active filter values into an immutable snapshot object.
   */
  function captureCurrentFilters() {
    return {
      status: state.filters.status,
      channel: state.filters.channel,
      category: state.filters.category
    };
  }

  /**
   * Checks whether state.filters currently matches the captured snapshot.
   * If user changed any filter in the meantime, returns false (stale).
   */
  function areFiltersCurrent(snapshot) {
    return (
      state.filters.status === snapshot.status &&
      state.filters.channel === snapshot.channel &&
      state.filters.category === snapshot.category
    );
  }

  /**
   * Acquires exclusive lock for data fetching & DOM manipulation.
   * - isBackground = true (pollLatestMessages): skips immediately if any request is active (returns 0).
   * - isBackground = false (user-initiated fetch): awaits active request completion, then acquires lock.
   */
  async function acquireLock(isBackground = false) {
    if (isBackground) {
      if (currentLock !== null) {
        return 0;
      }
    } else {
      while (currentLock !== null) {
        try {
          await currentLock.promise;
        } catch (_) {
          // Ignore errors from previous request; finally will release lock
        }
      }
    }

    const lockId = nextLockId++;
    let releaseFn;
    const promise = new Promise(resolve => {
      releaseFn = resolve;
    });

    currentLock = {
      lockId: lockId,
      promise: promise,
      release: releaseFn
    };

    return lockId;
  }

  /**
   * Releases exclusive lock only if the caller owns the active lockId.
   */
  function releaseLock(lockId) {
    if (currentLock && currentLock.lockId === lockId) {
      const release = currentLock.release;
      currentLock = null;
      if (release) {
        release();
      }
    }
  }

  // --- Data Fetching ---

  /**
   * Fetches messages from GET /api/messages
   * Supports:
   * - append: true (pagination, appends older items)
   * - append: false (initial load or full filter change)
   * - throwError: true (re-throws errors for manual refresh handling)
   */
  async function fetchMessages({ append = false, beforeId = null, isInitial = false, throwError = false, forceAuthToast = false } = {}) {
    const lockId = await acquireLock(false);
    if (!lockId) return false;

    // Capture active filters at the moment the request starts
    const requestFilters = captureCurrentFilters();

    if (isInitial) {
      tableLoadingSpinner.classList.remove('d-none');
      emptyStateContainer.classList.add('d-none');
    }

    if (append) {
      loadOlderBtn.disabled = true;
      loadOlderSpinner.classList.remove('d-none');
      loadOlderIcon.classList.add('d-none');
      loadOlderText.textContent = 'Loading older...';
    }

    // Build Query String using captured filters
    const params = new URLSearchParams();
    if (requestFilters.status) params.set('status', requestFilters.status);
    if (requestFilters.channel) params.set('channel', requestFilters.channel);
    if (requestFilters.category) params.set('category', requestFilters.category);
    if (beforeId) params.set('before_id', beforeId);
    params.set('limit', PAGE_LIMIT);

    try {
      const data = await DakGhar.fetch('/api/messages?' + params.toString(), { forceAuthToast });

      // If active filters changed while request was in-flight, discard this stale response
      if (!areFiltersCurrent(requestFilters)) {
        return false;
      }

      // 1. Always update global summary cards (Requirement 2)
      updateCountCards(data.counts);

      const incomingMessages = data.messages || [];

      if (append) {
        // Pagination: append older messages
        appendOlderMessages(incomingMessages);
      } else {
        // Fresh load or filter change
        replaceMessages(incomingMessages);
      }

      return true;

    } catch (err) {
      console.error('Failed to fetch outbox messages:', err);
      if (throwError) {
        throw err;
      }
      if (append && err && err.status && err.status !== 401 && err.status !== 403) {
        const errorMsg = (err.data && err.data.detail) || err.message || 'Failed to load older messages.';
        DakGhar.showToast(errorMsg, 'error');
      }
      return false;
    } finally {
      tableLoadingSpinner.classList.add('d-none');

      if (append) {
        loadOlderBtn.disabled = false;
        loadOlderSpinner.classList.add('d-none');
        loadOlderIcon.classList.remove('d-none');
        loadOlderText.textContent = 'Load older messages';
      }

      releaseLock(lockId);
    }
  }

  /**
   * Non-disruptive background polling:
   * 1. Preserves paginated older messages and reading position.
   * 2. Updates existing messages in place without rebuilding the whole table.
   * 3. Reconciles messages across all loaded pages, using before_id.
   * 4. Removes messages that stop matching active filters cleanly from the table.
   * 5. Queues genuinely new messages if user is interacting, or prepends them if at top.
   * 6. Always keeps global counts accurate.
   */
  async function pollLatestMessages() {
    // If no sender key is configured, background polling cannot succeed (avoids repetitive 401s)
    if (!DakGhar.getSenderKey()) {
      return;
    }

    const lockId = await acquireLock(true);
    if (!lockId) return; // Background poll skips if another fetch or poll is already running

    // Snapshot filters at start to detect if user changed them during async requests
    const requestFilters = captureCurrentFilters();

    const params = new URLSearchParams();
    if (requestFilters.status) params.set('status', requestFilters.status);
    if (requestFilters.channel) params.set('channel', requestFilters.channel);
    if (requestFilters.category) params.set('category', requestFilters.category);
    params.set('limit', PAGE_LIMIT);

    try {
      const data = await DakGhar.fetch('/api/messages?' + params.toString(), { silentAuth: true });

      // If user changed filters while fetch was in flight, discard response
      if (!areFiltersCurrent(requestFilters)) {
        return;
      }

      // Always update global summary counts from backend response
      updateCountCards(data.counts);

      const latest = data.messages || [];
      const hasFilter = Boolean(requestFilters.status || requestFilters.channel || requestFilters.category);

      let allMatching = latest.slice();
      let lastBatch = latest;

      // When user has loaded older paginated pages,
      // fetch subsequent pages using before_id so messages across all loaded pages are reconciled.
      if (state.oldestLoadedId !== null && latest.length > 0) {
        let lastFetchedId = allMatching[allMatching.length - 1].id;

        while (
          lastBatch.length === PAGE_LIMIT &&
          lastFetchedId > state.oldestLoadedId
        ) {
          const pageParams = new URLSearchParams();
          if (requestFilters.status) pageParams.set('status', requestFilters.status);
          if (requestFilters.channel) pageParams.set('channel', requestFilters.channel);
          if (requestFilters.category) pageParams.set('category', requestFilters.category);
          pageParams.set('before_id', lastFetchedId);
          pageParams.set('limit', PAGE_LIMIT);

          const pageData = await DakGhar.fetch('/api/messages?' + pageParams.toString(), { silentAuth: true });

          // Requirement 6: Check if filters changed during pagination fetch; discard if stale
          if (!areFiltersCurrent(requestFilters)) {
            return;
          }

          lastBatch = pageData.messages || [];
          if (lastBatch.length === 0) {
            break;
          }

          allMatching = allMatching.concat(lastBatch);
          lastFetchedId = lastBatch[lastBatch.length - 1].id;
        }
      }

      // Check again before applying response to state and DOM
      if (!areFiltersCurrent(requestFilters)) {
        return;
      }

      // Map matching messages by ID for fast lookup
      const allMatchingMap = new Map(allMatching.map(m => [m.id, m]));

      // 1. Handle messages that stop matching active filters across all loaded pages
      if (hasFilter) {
        if (allMatching.length === 0) {
          // No messages match the active filter anymore
          state.messages = [];
          state.messageIdSet.clear();
          state.oldestLoadedId = null;
          state.pendingNewMessages = [];
          hideNewMessagesBanner();
          renderTable();
          return;
        }

        // Clean up any queued pending new messages that no longer match the filter
        if (state.pendingNewMessages.length > 0) {
          state.pendingNewMessages = state.pendingNewMessages.filter(m => allMatchingMap.has(m.id));
          if (state.pendingNewMessages.length === 0) {
            hideNewMessagesBanner();
          } else {
            showNewMessagesBanner();
          }
        }

        // Identify and remove displayed rows that no longer match the active filter
        for (let i = state.messages.length - 1; i >= 0; i--) {
          const msg = state.messages[i];
          if (!allMatchingMap.has(msg.id)) {
            state.messages.splice(i, 1);
            state.messageIdSet.delete(msg.id);
            const tr = document.getElementById(`msg-row-${msg.id}`);
            if (tr) tr.remove();
          }
        }

        if (state.messages.length === 0) {
          state.oldestLoadedId = null;
          showEmptyState();
          tableStatusCount.textContent = '0 loaded';
          loadOlderBtn.classList.add('d-none');
          allLoadedMsg.classList.add('d-none');
          return;
        } else {
          hideEmptyState();
          state.oldestLoadedId = state.messages[state.messages.length - 1].id;
          tableStatusCount.textContent = `${state.messages.length} loaded`;

          // If the last fetched batch was smaller than PAGE_LIMIT, all matching messages have been loaded
          if (lastBatch.length < PAGE_LIMIT) {
            loadOlderBtn.classList.add('d-none');
            allLoadedMsg.classList.remove('d-none');
          } else {
            loadOlderBtn.classList.remove('d-none');
            allLoadedMsg.classList.add('d-none');
          }
        }
      }

      // 2. Update existing messages in place without rebuilding the DOM
      allMatching.forEach(m => {
        if (state.messageIdSet.has(m.id)) {
          // Update in state.messages array
          const idx = state.messages.findIndex(item => item.id === m.id);
          if (idx !== -1) {
            state.messages[idx] = Object.assign({}, state.messages[idx], m);
          }
          // Update DOM row in place
          const tr = document.getElementById(`msg-row-${m.id}`);
          if (tr) {
            updateRowElement(tr, m);
          }
        }
      });

      // 3. Find genuinely new messages (m.id > highest loaded ID)
      const topCurrentId = state.messages.length > 0 ? state.messages[0].id : 0;
      const brandNew = allMatching.filter(m => m.id > topCurrentId && !state.messageIdSet.has(m.id));

      if (brandNew.length > 0) {
        checkUserInteraction();

        if (state.isUserInteracting) {
          // User is scrolled or hovering: queue into pendingNewMessages and show floating pill
          const existingPendingIds = new Set(state.pendingNewMessages.map(m => m.id));
          brandNew.forEach(m => {
            if (!existingPendingIds.has(m.id)) {
              state.pendingNewMessages.unshift(m);
            }
          });
          showNewMessagesBanner();
        } else {
          // User is at top and not interacting: safely prepend new rows
          brandNew.slice().reverse().forEach(m => {
            if (!state.messageIdSet.has(m.id)) {
              state.messageIdSet.add(m.id);
              state.messages.unshift(m);
              const tr = createMessageRow(m);
              if (messagesTableBody.firstChild) {
                messagesTableBody.insertBefore(tr, messagesTableBody.firstChild);
              } else {
                messagesTableBody.appendChild(tr);
              }
            }
          });
          hideEmptyState();
          tableStatusCount.textContent = `${state.messages.length} loaded`;
          if (state.oldestLoadedId === null && state.messages.length > 0) {
            state.oldestLoadedId = state.messages[state.messages.length - 1].id;
          }
        }
      }

    } catch (err) {
      // Non-intrusive logging for background polling
      console.warn('Background poll error:', err);
    } finally {
      releaseLock(lockId);
    }
  }

  // --- Rendering & DOM Manipulation (Strictly textContent / XSS Safe) ---

  function createMessageRow(m) {
    const tr = document.createElement('tr');
    tr.id = `msg-row-${m.id}`;
    tr.setAttribute('tabindex', '0');
    tr.setAttribute('role', 'row');
    tr.title = `Click to view details for Message #${m.id}`;

    // Clicking row navigates to message.html?id=ID
    tr.addEventListener('click', () => {
      window.location.href = `message.html?id=${m.id}`;
    });

    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        window.location.href = `message.html?id=${m.id}`;
      }
    });

    // 1. # ID Cell (Mobile header container)
    const tdId = document.createElement('td');
    tdId.className = 'font-monospace fw-semibold text-primary mobile-card-header';
    tdId.setAttribute('data-label', '# ID');

    const idSpan = document.createElement('span');
    idSpan.textContent = `#${m.id}`;
    tdId.appendChild(idSpan);

    // On mobile, show status badge on top right of the card
    const mobileStatusWrap = document.createElement('span');
    mobileStatusWrap.className = 'd-md-none ms-auto';
    mobileStatusWrap.appendChild(createStatusBadge(m.status));
    tdId.appendChild(mobileStatusWrap);

    tr.appendChild(tdId);

    // 2. Age Cell
    const tdAge = document.createElement('td');
    tdAge.setAttribute('data-label', 'Created');
    tdAge.className = 'text-muted small';
    tdAge.textContent = DakGhar.formatAge(m.created_at);
    tdAge.title = DakGhar.formatDateTime(m.created_at);
    tr.appendChild(tdAge);

    // 3. Channel Cell
    const tdChannel = document.createElement('td');
    tdChannel.setAttribute('data-label', 'Channel');
    const channelIcon = document.createElement('i');
    channelIcon.className = m.channel === 'email' ? 'bi bi-envelope-fill me-1 text-primary' : 'bi bi-chat-dots-fill me-1 text-success';
    const channelText = document.createElement('span');
    channelText.textContent = m.channel.toUpperCase();
    tdChannel.appendChild(channelIcon);
    tdChannel.appendChild(channelText);
    tr.appendChild(tdChannel);

    // 4. Category Cell
    const tdCategory = document.createElement('td');
    tdCategory.setAttribute('data-label', 'Category');
    const catBadge = document.createElement('span');
    catBadge.className = m.category === 'transactional' ? 'badge badge-cat-transactional' : 'badge badge-cat-marketing';
    catBadge.textContent = m.category;
    tdCategory.appendChild(catBadge);
    tr.appendChild(tdCategory);

    // 5. Recipient Cell (Masked for privacy)
    const tdRecipient = document.createElement('td');
    tdRecipient.setAttribute('data-label', 'Recipient');
    tdRecipient.className = 'font-monospace text-truncate-cell';
    tdRecipient.textContent = DakGhar.maskRecipient(m.recipient);
    tdRecipient.title = DakGhar.maskRecipient(m.recipient);
    tr.appendChild(tdRecipient);

    // 6. Subject / Preview Cell (Safe textContent)
    const tdSubject = document.createElement('td');
    tdSubject.setAttribute('data-label', 'Subject');
    tdSubject.className = 'text-truncate-cell';
    const previewText = m.subject ? m.subject : m.body;
    tdSubject.textContent = previewText || '—';
    tdSubject.title = previewText || '';
    tr.appendChild(tdSubject);

    // 7. Status Badge Cell (Desktop only, mobile renders in card header)
    const tdStatus = document.createElement('td');
    tdStatus.setAttribute('data-label', 'Status');
    tdStatus.className = 'd-none d-md-table-cell';
    tdStatus.appendChild(createStatusBadge(m.status));
    tr.appendChild(tdStatus);

    // 8. Attempts Count Cell
    const tdAttempts = document.createElement('td');
    tdAttempts.setAttribute('data-label', 'Attempts');
    const attemptsBadge = document.createElement('span');
    attemptsBadge.className = 'badge bg-light text-dark border';
    attemptsBadge.textContent = String(m.attempts || 0);
    tdAttempts.appendChild(attemptsBadge);
    tr.appendChild(tdAttempts);

    // 9. Provider Cell
    const tdProvider = document.createElement('td');
    tdProvider.setAttribute('data-label', 'Provider');
    if (m.provider) {
      const providerBadge = document.createElement('span');
      providerBadge.className = 'badge badge-provider';
      providerBadge.textContent = m.provider;
      tdProvider.appendChild(providerBadge);
    } else {
      tdProvider.textContent = '—';
    }
    tr.appendChild(tdProvider);

    // 10. Last Error Cell (Rendered safely)
    const tdError = document.createElement('td');
    tdError.setAttribute('data-label', 'Last Error');
    tdError.className = 'text-danger small text-truncate-cell';
    tdError.textContent = m.last_error || '—';
    if (m.last_error) {
      tdError.title = m.last_error;
    }
    tr.appendChild(tdError);

    return tr;
  }

  function updateRowElement(tr, m) {
    if (!tr) return;

    // Update Age
    const tdAge = tr.querySelector('td[data-label="Created"]');
    if (tdAge) {
      tdAge.textContent = DakGhar.formatAge(m.created_at);
      tdAge.title = DakGhar.formatDateTime(m.created_at);
    }

    // Update Desktop Status Badge
    const tdStatus = tr.querySelector('td.d-none.d-md-table-cell');
    if (tdStatus) {
      tdStatus.replaceChildren(createStatusBadge(m.status));
    }

    // Update Mobile Status Badge in card header
    const mobileStatusWrap = tr.querySelector('.mobile-card-header .ms-auto');
    if (mobileStatusWrap) {
      mobileStatusWrap.replaceChildren(createStatusBadge(m.status));
    }

    // Update Attempts Count
    const tdAttemptsBadge = tr.querySelector('td[data-label="Attempts"] .badge');
    if (tdAttemptsBadge) {
      tdAttemptsBadge.textContent = String(m.attempts || 0);
    }

    // Update Provider
    const tdProvider = tr.querySelector('td[data-label="Provider"]');
    if (tdProvider) {
      if (m.provider) {
        tdProvider.replaceChildren();
        const providerBadge = document.createElement('span');
        providerBadge.className = 'badge badge-provider';
        providerBadge.textContent = m.provider;
        tdProvider.appendChild(providerBadge);
      } else {
        tdProvider.textContent = '—';
      }
    }

    // Update Last Error
    const tdError = tr.querySelector('td[data-label="Last Error"]');
    if (tdError) {
      tdError.textContent = m.last_error || '—';
      tdError.title = m.last_error || '';
    }
  }

  function createStatusBadge(status) {
    const badge = document.createElement('span');
    badge.className = `badge badge-status badge-${status}`;
    badge.setAttribute('aria-label', `Status: ${status}`);

    const icon = document.createElement('i');
    if (status === 'pending') {
      icon.className = 'bi bi-clock-history';
    } else if (status === 'sending') {
      icon.className = 'bi bi-arrow-repeat spinner-border-sm';
    } else if (status === 'sent') {
      icon.className = 'bi bi-check-circle-fill';
    } else if (status === 'failed') {
      icon.className = 'bi bi-x-circle-fill';
    }

    const text = document.createElement('span');
    text.textContent = status.charAt(0).toUpperCase() + status.slice(1);

    badge.appendChild(icon);
    badge.appendChild(text);
    return badge;
  }

  function replaceMessages(incoming) {
    state.messages = incoming.slice();
    state.messageIdSet.clear();
    incoming.forEach(m => state.messageIdSet.add(m.id));

    if (incoming.length > 0) {
      state.oldestLoadedId = incoming[incoming.length - 1].id;
    } else {
      state.oldestLoadedId = null;
    }

    renderTable();

    // Check if more older messages could exist
    if (incoming.length < PAGE_LIMIT) {
      loadOlderBtn.classList.add('d-none');
      if (incoming.length > 0) {
        allLoadedMsg.classList.remove('d-none');
      } else {
        allLoadedMsg.classList.add('d-none');
      }
    } else {
      loadOlderBtn.classList.remove('d-none');
      allLoadedMsg.classList.add('d-none');
    }
  }

  function appendOlderMessages(olderMessages) {
    if (!olderMessages || olderMessages.length === 0) {
      loadOlderBtn.classList.add('d-none');
      allLoadedMsg.classList.remove('d-none');
      return;
    }

    // Filter duplicates
    const uniqueOlder = olderMessages.filter(m => !state.messageIdSet.has(m.id));
    if (uniqueOlder.length === 0) {
      loadOlderBtn.classList.add('d-none');
      allLoadedMsg.classList.remove('d-none');
      return;
    }

    uniqueOlder.forEach(m => {
      state.messageIdSet.add(m.id);
      state.messages.push(m);
      const tr = createMessageRow(m);
      messagesTableBody.appendChild(tr);
    });

    state.oldestLoadedId = uniqueOlder[uniqueOlder.length - 1].id;
    tableStatusCount.textContent = `${state.messages.length} loaded`;

    if (olderMessages.length < PAGE_LIMIT) {
      loadOlderBtn.classList.add('d-none');
      allLoadedMsg.classList.remove('d-none');
    } else {
      loadOlderBtn.classList.remove('d-none');
      allLoadedMsg.classList.add('d-none');
    }
  }

  function renderTable() {
    messagesTableBody.replaceChildren();

    if (state.messages.length === 0) {
      showEmptyState();
      tableStatusCount.textContent = '0 loaded';
      return;
    }

    hideEmptyState();

    state.messages.forEach(m => {
      const tr = createMessageRow(m);
      messagesTableBody.appendChild(tr);
    });

    tableStatusCount.textContent = `${state.messages.length} loaded`;
  }

  function showEmptyState() {
    emptyStateContainer.classList.remove('d-none');
    tableWrapper.classList.add('d-none');
    loadOlderBtn.classList.add('d-none');
    allLoadedMsg.classList.add('d-none');
  }

  function hideEmptyState() {
    emptyStateContainer.classList.add('d-none');
    tableWrapper.classList.remove('d-none');
  }

  function showNewMessagesBanner() {
    const count = state.pendingNewMessages.length;
    if (count > 0) {
      newMessagesCountText.textContent = `↑ ${count} new message${count > 1 ? 's' : ''} arrived — click to view`;
      newMessagesBanner.classList.remove('d-none');
    }
  }

  function hideNewMessagesBanner() {
    newMessagesBanner.classList.add('d-none');
    state.pendingNewMessages = [];
  }

  // --- Filter Event Handlers ---

  function applyFilterChange() {
    state.filters.status = filterStatus.value;
    state.filters.channel = filterChannel.value;
    state.filters.category = filterCategory.value;

    savePreferences();
    updateCountCardsHighlight();
    hideNewMessagesBanner();

    // Re-fetch messages from scratch
    fetchMessages({ append: false, isInitial: true });
  }

  filterStatus.addEventListener('change', applyFilterChange);
  filterChannel.addEventListener('change', applyFilterChange);
  filterCategory.addEventListener('change', applyFilterChange);

  clearFiltersBtn.addEventListener('click', () => {
    state.filters.status = '';
    state.filters.channel = '';
    state.filters.category = '';
    filterStatus.value = '';
    filterChannel.value = '';
    filterCategory.value = '';

    savePreferences();
    updateCountCardsHighlight();
    hideNewMessagesBanner();
    fetchMessages({ append: false, isInitial: true });
  });

  // --- Count Cards Click Handler (Toggle Filter) ---

  function handleCardClick(status) {
    if (state.filters.status === status) {
      // Toggle off if already selected
      state.filters.status = '';
      filterStatus.value = '';
    } else {
      // Select new status
      state.filters.status = status;
      filterStatus.value = status;
    }
    applyFilterChange();
  }

  cardPending.addEventListener('click', () => handleCardClick('pending'));
  cardSending.addEventListener('click', () => handleCardClick('sending'));
  cardSent.addEventListener('click', () => handleCardClick('sent'));
  cardFailed.addEventListener('click', () => handleCardClick('failed'));

  // --- Auto-Refresh Controls ---

  autoRefreshSwitch.addEventListener('change', () => {
    state.autoRefresh = autoRefreshSwitch.checked;
    updateAutoRefreshUI();
    savePreferences();

    if (state.autoRefresh) {
      startPolling();
      DakGhar.showToast('Auto-refresh resumed (every 2s).', 'info');
    } else {
      stopPolling();
      DakGhar.showToast('Auto-refresh paused.', 'info');
    }
  });

  // Requirement 3: Correct manual refresh feedback flow
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshIcon.classList.add('spin-animation');

    try {
      const success = await fetchMessages({ append: false, throwError: true, forceAuthToast: true });
      if (success) {
        DakGhar.showToast('Outbox refreshed.', 'success');
      }
    } catch (err) {
      console.error('Manual refresh failed:', err);
      // HTTP error handling (api.js already handles network failures and 401/403)
      if (err && err.status && err.status !== 401 && err.status !== 403) {
        const errorMsg = (err.data && err.data.detail) || err.message || 'Failed to refresh outbox.';
        DakGhar.showToast(errorMsg, 'error');
      }
    } finally {
      refreshIcon.classList.remove('spin-animation');
      refreshBtn.disabled = false;
    }
  });

  // Click on "↑ N new messages" pill: prepends new rows without re-rendering older paginated rows
  newMessagesPill.addEventListener('click', () => {
    if (state.pendingNewMessages.length > 0) {
      const toPrepend = state.pendingNewMessages.slice();
      hideNewMessagesBanner();

      toPrepend.reverse().forEach(m => {
        if (!state.messageIdSet.has(m.id)) {
          state.messageIdSet.add(m.id);
          state.messages.unshift(m);
          const tr = createMessageRow(m);
          if (messagesTableBody.firstChild) {
            messagesTableBody.insertBefore(tr, messagesTableBody.firstChild);
          } else {
            messagesTableBody.appendChild(tr);
          }
        }
      });

      hideEmptyState();
      tableStatusCount.textContent = `${state.messages.length} loaded`;
      if (state.oldestLoadedId === null && state.messages.length > 0) {
        state.oldestLoadedId = state.messages[state.messages.length - 1].id;
      }

      // Smooth scroll to top of table
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  // --- Pagination Click Handler ---

  loadOlderBtn.addEventListener('click', () => {
    if (state.oldestLoadedId) {
      fetchMessages({ append: true, beforeId: state.oldestLoadedId, forceAuthToast: true });
    }
  });

  // Listen for key updates from Settings modal to immediately resume Outbox functionality
  window.addEventListener('dakghar:keys-updated', () => {
    fetchMessages({ append: false, isInitial: true });
  });

  // --- Initial Startup ---

  loadSavedPreferences();
  fetchMessages({ append: false, isInitial: true }).finally(() => {
    startPolling();
  });
});
