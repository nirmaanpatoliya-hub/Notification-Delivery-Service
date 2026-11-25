/**
 * DakGhar (डाकघर) Notification Delivery Service - Screen 5: Fake Inbox
 *
 * Responsibilities:
 * 1. Fetches and displays simulated delivered messages from GET /api/inbox.
 * 2. Displays provider, delivery timestamp, recipient, subject (for email) or message text (for SMS), and associated message number.
 * 3. Provides provider filter using actual backend provider values, plus channel and text search filters.
 * 4. Links message numbers to Message Detail screen (message.html?id=ID).
 * 5. Provides interactive message preview modal for inspecting simulated deliveries.
 * 6. Handles loading, empty, and API-error states gracefully.
 * 7. Follows shared DakGhar API client, auth handling, and XSS-safe DOM rendering.
 * 8. Responsive down to 375px mobile stacked card layout.
 * 9. Non-overlapping background polling when tab is visible.
 */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // --- Configuration & Constants ---
  const POLL_INTERVAL_MS = 3000; // 3-second auto-refresh
  const INBOX_LIMIT = 100;       // Fetch up to 100 recent inbox records

  // --- State ---
  const state = {
    messages: [],             // All fetched messages from /api/inbox
    filteredMessages: [],     // Messages after active filters applied
    providers: [],            // List of provider objects from /api/providers
    activeProvider: '',       // Selected provider filter
    activeChannel: '',        // Selected channel filter ('', 'email', 'sms')
    searchQuery: '',          // Search term filter
    isLoading: false,         // Guard against concurrent fetches
    isBackgroundPoll: false,  // Flag if current fetch is background polling
    autoRefresh: true,        // Auto-refresh switch status
    pollTimer: null,          // setInterval reference
    selectedMessage: null,    // Currently inspected message in preview modal
    hasAuthError: false       // Track if 401 occurred
  };

  // --- DOM Elements ---
  const refreshBtn = document.getElementById('refreshBtn');
  const refreshIcon = document.getElementById('refreshIcon');
  const autoRefreshSwitch = document.getElementById('autoRefreshSwitch');
  const autoRefreshLabel = document.getElementById('autoRefreshLabel');
  const authNotice = document.getElementById('authNotice');

  // Stats Elements
  const countTotalDelivered = document.getElementById('countTotalDelivered');
  const countEmailDelivered = document.getElementById('countEmailDelivered');
  const countSmsDelivered = document.getElementById('countSmsDelivered');
  const countFilteredResults = document.getElementById('countFilteredResults');
  const filterStatusText = document.getElementById('filterStatusText');
  const cardTotalDelivered = document.getElementById('cardTotalDelivered');
  const cardEmailDelivered = document.getElementById('cardEmailDelivered');
  const cardSmsDelivered = document.getElementById('cardSmsDelivered');

  // Filter Elements
  const filterProvider = document.getElementById('filterProvider');
  const filterChannel = document.getElementById('filterChannel');
  const filterSearch = document.getElementById('filterSearch');
  const clearFiltersBtn = document.getElementById('clearFiltersBtn');

  // Table & State Containers
  const inboxStatusCount = document.getElementById('inboxStatusCount');
  const inboxLastUpdated = document.getElementById('inboxLastUpdated');
  const tableLoadingSpinner = document.getElementById('tableLoadingSpinner');
  const tableErrorContainer = document.getElementById('tableErrorContainer');
  const tableErrorTitle = document.getElementById('tableErrorTitle');
  const tableErrorMessage = document.getElementById('tableErrorMessage');
  const retryFetchBtn = document.getElementById('retryFetchBtn');
  const emptyStateContainer = document.getElementById('emptyStateContainer');
  const emptyStateTitle = document.getElementById('emptyStateTitle');
  const emptyStateMessage = document.getElementById('emptyStateMessage');
  const tableWrapper = document.getElementById('tableWrapper');
  const inboxTableBody = document.getElementById('inboxTableBody');
  const footerCountText = document.getElementById('footerCountText');

  // Modal Elements
  const viewMessageModalEl = document.getElementById('viewMessageModal');
  const modalChannelIcon = document.getElementById('modalChannelIcon');
  const modalProviderName = document.getElementById('modalProviderName');
  const modalDeliveredAt = document.getElementById('modalDeliveredAt');
  const modalRecipient = document.getElementById('modalRecipient');
  const modalMessageLink = document.getElementById('modalMessageLink');
  const modalMessageId = document.getElementById('modalMessageId');
  const modalSubjectContainer = document.getElementById('modalSubjectContainer');
  const modalSubject = document.getElementById('modalSubject');
  const modalBody = document.getElementById('modalBody');
  const modalDetailBtn = document.getElementById('modalDetailBtn');

  let bsViewModal = null;
  if (viewMessageModalEl && window.bootstrap && window.bootstrap.Modal) {
    bsViewModal = new window.bootstrap.Modal(viewMessageModalEl);
  }

  // --- Helpers ---

  /**
   * Determine channel for a message.
   * Uses subject presence or known provider channel mappings.
   */
  function getChannel(message) {
    if (message.subject !== null && message.subject !== undefined) {
      return 'email';
    }
    const prov = (message.provider || '').toLowerCase();
    if (prov === 'mailfast' || prov === 'postbird') {
      return 'email';
    }
    if (prov === 'smsly' || prov === 'textgo') {
      return 'sms';
    }
    // Fallback: check recipient format
    if (message.recipient && message.recipient.includes('@')) {
      return 'email';
    }
    return 'sms';
  }

  /**
   * Return options for DakGhar.fetch() that ensure authentication
   * works for both Sender and Admin keys according to API requirements.
   */
  function getFetchOptions(options = {}) {
    const senderKey = DakGhar.getSenderKey();
    const adminKey = DakGhar.getAdminKey();
    const headers = Object.assign({}, options.headers || {});

    // If no senderKey is saved but an adminKey is present, attach X-Api-Key
    // so require_sender dependency accepts the admin key.
    if (!senderKey && adminKey) {
      headers['X-Api-Key'] = adminKey;
    }

    return Object.assign({}, options, { headers });
  }

  // --- Data Fetching ---

  /**
   * Fetch provider definitions from GET /api/providers to populate filter dropdown.
   */
  async function fetchProviders() {
    try {
      const data = await DakGhar.fetch('/api/providers', getFetchOptions({ silentAuth: true }));
      if (Array.isArray(data)) {
        state.providers = data;
        populateProviderDropdown(data);
      }
    } catch (err) {
      console.warn('Could not load /api/providers for filter list:', err);
      // Fallback: populate standard known mock providers
      const fallbackProviders = [
        { name: 'mailfast', channel: 'email' },
        { name: 'postbird', channel: 'email' },
        { name: 'smsly', channel: 'sms' },
        { name: 'textgo', channel: 'sms' }
      ];
      state.providers = fallbackProviders;
      populateProviderDropdown(fallbackProviders);
    }
  }

  /**
   * Populate the provider select element with backend providers.
   */
  function populateProviderDropdown(providers) {
    const currentVal = filterProvider.value;
    filterProvider.innerHTML = '<option value="">All Providers</option>';

    providers.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      const channelLabel = p.channel ? ` (${p.channel.toUpperCase()})` : '';
      opt.textContent = `${p.name}${channelLabel}`;
      filterProvider.appendChild(opt);
    });

    if (currentVal) {
      filterProvider.value = currentVal;
    }
  }

  /**
   * Fetch inbox deliveries from GET /api/inbox.
   * Supports backend filtering via `?provider=...`.
   */
  async function fetchInboxMessages({ isBackground = false } = {}) {
    if (state.isLoading) return;
    state.isLoading = true;
    state.isBackgroundPoll = isBackground;

    if (!isBackground) {
      showLoadingState();
      if (refreshIcon) refreshIcon.classList.add('spin-animation');
    }

    try {
      const params = new URLSearchParams();
      params.set('limit', String(INBOX_LIMIT));

      if (state.activeProvider) {
        params.set('provider', state.activeProvider);
      }

      const endpoint = `/api/inbox?${params.toString()}`;
      const data = await DakGhar.fetch(endpoint, getFetchOptions({ silentAuth: isBackground }));

      state.hasAuthError = false;
      if (authNotice) authNotice.classList.add('d-none');

      if (Array.isArray(data)) {
        state.messages = data;
        applyFiltersAndRender();
        updateSummaryStats(data);
      } else {
        state.messages = [];
        applyFiltersAndRender();
      }

      if (inboxLastUpdated) {
        const now = new Date();
        inboxLastUpdated.textContent = `Updated ${now.toLocaleTimeString()}`;
      }
    } catch (err) {
      console.error('Failed to fetch /api/inbox:', err);
      if (err && err.status === 401) {
        state.hasAuthError = true;
        if (authNotice) authNotice.classList.remove('d-none');
        if (!isBackground) {
          showErrorState('API Key Missing or Required', 'An API key is required to view the Fake Inbox. Please configure your Sender Key or Admin Key in Settings.');
        }
      } else if (err && err.status === 403) {
        if (!isBackground) {
          showErrorState('Access Denied (403)', 'Your configured API key does not have permission to access the Fake Inbox.');
        }
      } else {
        if (!isBackground) {
          const errMsg = (err && err.data && err.data.detail) || err.message || 'Server error occurred.';
          showErrorState('Unable to Load Fake Inbox', errMsg);
        }
      }
    } finally {
      state.isLoading = false;
      if (refreshIcon) refreshIcon.classList.remove('spin-animation');
    }
  }

  // --- Filtering & Stats Calculation ---

  function applyFiltersAndRender() {
    let list = state.messages.slice();

    // 1. Filter by Channel
    if (state.activeChannel) {
      list = list.filter(m => getChannel(m) === state.activeChannel);
    }

    // 2. Filter by Search Query
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      list = list.filter(m => {
        const recipient = (m.recipient || '').toLowerCase();
        const subject = (m.subject || '').toLowerCase();
        const body = (m.body || '').toLowerCase();
        const msgId = String(m.message_id || '');
        const provider = (m.provider || '').toLowerCase();
        return recipient.includes(q) || subject.includes(q) || body.includes(q) || msgId.includes(q) || provider.includes(q);
      });
    }

    state.filteredMessages = list;
    renderTable(list);

    // Update filter status counter
    if (countFilteredResults) {
      countFilteredResults.textContent = String(list.length);
    }
    if (filterStatusText) {
      const parts = [];
      if (state.activeProvider) parts.push(state.activeProvider);
      if (state.activeChannel) parts.push(state.activeChannel.toUpperCase());
      if (state.searchQuery) parts.push(`"${state.searchQuery}"`);
      filterStatusText.textContent = parts.length > 0 ? parts.join(' · ') : 'All deliveries';
    }
  }

  function updateSummaryStats(allMessages) {
    let emailCount = 0;
    let smsCount = 0;

    allMessages.forEach(m => {
      const ch = getChannel(m);
      if (ch === 'email') emailCount++;
      else if (ch === 'sms') smsCount++;
    });

    if (countTotalDelivered) countTotalDelivered.textContent = String(allMessages.length);
    if (countEmailDelivered) countEmailDelivered.textContent = String(emailCount);
    if (countSmsDelivered) countSmsDelivered.textContent = String(smsCount);
  }

  // --- DOM Rendering ---

  function showLoadingState() {
    tableLoadingSpinner.classList.remove('d-none');
    tableErrorContainer.classList.add('d-none');
    emptyStateContainer.classList.add('d-none');
    tableWrapper.classList.add('d-none');
  }

  function showErrorState(title, message) {
    tableLoadingSpinner.classList.add('d-none');
    tableErrorContainer.classList.remove('d-none');
    emptyStateContainer.classList.add('d-none');
    tableWrapper.classList.add('d-none');

    DakGhar.setText(tableErrorTitle, title);
    DakGhar.setText(tableErrorMessage, message);
  }

  function showEmptyState(message) {
    tableLoadingSpinner.classList.add('d-none');
    tableErrorContainer.classList.add('d-none');
    emptyStateContainer.classList.remove('d-none');
    tableWrapper.classList.add('d-none');

    if (message) {
      DakGhar.setText(emptyStateMessage, message);
    }
  }

  function showTableState() {
    tableLoadingSpinner.classList.add('d-none');
    tableErrorContainer.classList.add('d-none');
    emptyStateContainer.classList.add('d-none');
    tableWrapper.classList.remove('d-none');
  }

  /**
   * Render inbox records into the table.
   * Follows strict XSS safety by constructing elements and textContent.
   */
  function renderTable(messages) {
    if (messages.length === 0) {
      if (state.messages.length === 0) {
        showEmptyState('No messages delivered yet. Send a notification from the Send Message screen or wait for pending messages to be picked up by the worker.');
      } else {
        showEmptyState('No delivered messages match your current filter selection.');
      }
      inboxStatusCount.textContent = '0 messages';
      footerCountText.textContent = '0 messages displayed';
      return;
    }

    showTableState();
    inboxStatusCount.textContent = `${messages.length} message${messages.length === 1 ? '' : 's'}`;
    footerCountText.textContent = `Showing ${messages.length} of ${state.messages.length} delivered message${state.messages.length === 1 ? '' : 's'}`;

    inboxTableBody.innerHTML = '';

    messages.forEach(m => {
      const channel = getChannel(m);
      const tr = document.createElement('tr');
      tr.className = 'inbox-row';
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('role', 'row');
      tr.title = `Click to view preview for Message #${m.message_id}`;

      // Open message preview modal on row click (unless user clicked the direct link)
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a')) return; // Allow normal link navigation
        openMessagePreview(m);
      });

      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if (e.target.closest('a')) return;
          e.preventDefault();
          openMessagePreview(m);
        }
      });

      // 1. # Message Link Cell (with mobile card header)
      const tdId = document.createElement('td');
      tdId.className = 'mobile-card-header';
      tdId.setAttribute('data-label', '# Message');

      const msgLink = document.createElement('a');
      msgLink.href = `message.html?id=${m.message_id}`;
      msgLink.className = 'badge bg-primary-subtle text-primary border border-primary-subtle text-decoration-none font-monospace fw-bold';
      msgLink.textContent = `#${m.message_id}`;
      msgLink.title = `Open Message #${m.message_id} Detail`;
      tdId.appendChild(msgLink);

      // On mobile: show provider badge on top right of the stacked card
      const mobileBadgeWrap = document.createElement('span');
      mobileBadgeWrap.className = 'd-md-none ms-auto';
      mobileBadgeWrap.appendChild(createProviderBadge(m.provider, channel));
      tdId.appendChild(mobileBadgeWrap);

      tr.appendChild(tdId);

      // 2. Delivered Timestamp Cell
      const tdDelivered = document.createElement('td');
      tdDelivered.setAttribute('data-label', 'Delivered');
      const deliveredTime = m.delivered_at ? new Date(m.delivered_at * 1000) : null;

      const ageSpan = document.createElement('span');
      ageSpan.className = 'small fw-medium';
      ageSpan.textContent = m.delivered_at ? DakGhar.formatAge(m.delivered_at) : '—';
      if (deliveredTime) {
        ageSpan.title = deliveredTime.toLocaleString();
      }
      tdDelivered.appendChild(ageSpan);

      if (deliveredTime) {
        const timeSub = document.createElement('div');
        timeSub.className = 'small text-muted font-monospace d-none d-lg-block';
        timeSub.style.fontSize = '0.72rem';
        timeSub.textContent = deliveredTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        tdDelivered.appendChild(timeSub);
      }
      tr.appendChild(tdDelivered);

      // 3. Provider Cell (Desktop view)
      const tdProvider = document.createElement('td');
      tdProvider.className = 'd-none d-md-table-cell';
      tdProvider.setAttribute('data-label', 'Provider');
      tdProvider.appendChild(createProviderBadge(m.provider, channel));
      tr.appendChild(tdProvider);

      // 4. Recipient Cell
      const tdRecipient = document.createElement('td');
      tdRecipient.setAttribute('data-label', 'Recipient');

      const recipientSpan = document.createElement('span');
      recipientSpan.className = 'font-monospace small text-break';
      recipientSpan.textContent = m.recipient || '—';
      tdRecipient.appendChild(recipientSpan);

      // Channel pill
      const channelPill = document.createElement('span');
      channelPill.className = `badge ${channel === 'email' ? 'bg-primary-subtle text-primary border-primary-subtle' : 'bg-purple-subtle text-purple border-purple-subtle'} border ms-1 d-none d-xl-inline-block`;
      channelPill.style.fontSize = '0.68rem';
      channelPill.textContent = channel.toUpperCase();
      tdRecipient.appendChild(channelPill);

      tr.appendChild(tdRecipient);

      // 5. Subject / Delivered Content Cell
      const tdContent = document.createElement('td');
      tdContent.setAttribute('data-label', 'Delivered Content');

      if (m.subject) {
        const subjDiv = document.createElement('div');
        subjDiv.className = 'fw-semibold small text-truncate';
        subjDiv.style.maxWidth = '400px';
        subjDiv.textContent = m.subject;
        tdContent.appendChild(subjDiv);
      }

      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'small text-muted text-truncate';
      bodyDiv.style.maxWidth = '400px';
      bodyDiv.textContent = m.body || '(empty message)';
      tdContent.appendChild(bodyDiv);

      tr.appendChild(tdContent);

      // 6. Action Cell (Preview Envelope button)
      const tdAction = document.createElement('td');
      tdAction.className = 'text-end';
      tdAction.setAttribute('data-label', 'Preview');

      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'btn btn-sm btn-outline-secondary py-0 px-2';
      previewBtn.title = 'Preview delivered notification';
      previewBtn.innerHTML = '<i class="bi bi-eye me-1"></i>View';
      previewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openMessagePreview(m);
      });
      tdAction.appendChild(previewBtn);

      tr.appendChild(tdAction);

      inboxTableBody.appendChild(tr);
    });
  }

  /**
   * Helper to build a clean provider badge with appropriate channel icon.
   */
  function createProviderBadge(providerName, channel) {
    const span = document.createElement('span');
    span.className = 'badge badge-provider d-inline-flex align-items-center gap-1';

    const icon = document.createElement('i');
    if (channel === 'email') {
      icon.className = 'bi bi-envelope-fill text-primary';
    } else {
      icon.className = 'bi bi-chat-text-fill text-purple';
    }
    span.appendChild(icon);

    const nameText = document.createTextNode(providerName || 'unknown');
    span.appendChild(nameText);

    return span;
  }

  // --- Message Preview Modal ---

  function openMessagePreview(message) {
    state.selectedMessage = message;
    const channel = getChannel(message);

    // Channel icon
    if (modalChannelIcon) {
      modalChannelIcon.className = channel === 'email'
        ? 'bi bi-envelope-paper-fill text-primary fs-5'
        : 'bi bi-chat-square-text-fill text-purple fs-5';
    }

    // Modal fields
    DakGhar.setText(modalProviderName, message.provider ? `${message.provider} (${channel.toUpperCase()})` : '—');
    DakGhar.setText(modalDeliveredAt, message.delivered_at ? `${new Date(message.delivered_at * 1000).toLocaleString()} (${DakGhar.formatAge(message.delivered_at)})` : '—');
    DakGhar.setText(modalRecipient, message.recipient || '—');
    DakGhar.setText(modalMessageId, `#${message.message_id}`);

    if (modalMessageLink) {
      modalMessageLink.href = `message.html?id=${message.message_id}`;
    }
    if (modalDetailBtn) {
      modalDetailBtn.href = `message.html?id=${message.message_id}`;
    }

    // Subject (visible for emails, hidden if null/empty)
    if (modalSubjectContainer) {
      if (message.subject) {
        modalSubjectContainer.classList.remove('d-none');
        DakGhar.setText(modalSubject, message.subject);
      } else {
        modalSubjectContainer.classList.add('d-none');
      }
    }

    // Body
    DakGhar.setText(modalBody, message.body || '(empty message body)');

    // Show modal
    if (bsViewModal) {
      bsViewModal.show();
    }
  }

  // --- Event Listeners ---

  // Provider Filter change
  filterProvider.addEventListener('change', () => {
    state.activeProvider = filterProvider.value;
    fetchInboxMessages({ isBackground: false });
  });

  // Channel Filter change
  filterChannel.addEventListener('change', () => {
    state.activeChannel = filterChannel.value;
    applyFiltersAndRender();
  });

  // Search input change (with debounced input)
  let searchTimeout = null;
  filterSearch.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.searchQuery = filterSearch.value.trim();
      applyFiltersAndRender();
    }, 150);
  });

  // Reset Filters button
  clearFiltersBtn.addEventListener('click', () => {
    filterProvider.value = '';
    filterChannel.value = '';
    filterSearch.value = '';
    state.activeProvider = '';
    state.activeChannel = '';
    state.searchQuery = '';
    fetchInboxMessages({ isBackground: false });
  });

  // Top summary cards quick-filtering
  if (cardTotalDelivered) {
    cardTotalDelivered.addEventListener('click', () => {
      filterProvider.value = '';
      filterChannel.value = '';
      state.activeProvider = '';
      state.activeChannel = '';
      fetchInboxMessages({ isBackground: false });
    });
  }

  if (cardEmailDelivered) {
    cardEmailDelivered.addEventListener('click', () => {
      filterChannel.value = 'email';
      state.activeChannel = 'email';
      applyFiltersAndRender();
    });
  }

  if (cardSmsDelivered) {
    cardSmsDelivered.addEventListener('click', () => {
      filterChannel.value = 'sms';
      state.activeChannel = 'sms';
      applyFiltersAndRender();
    });
  }

  // Manual refresh button
  refreshBtn.addEventListener('click', () => {
    fetchInboxMessages({ isBackground: false });
  });

  // Retry button in error container
  if (retryFetchBtn) {
    retryFetchBtn.addEventListener('click', () => {
      fetchInboxMessages({ isBackground: false });
    });
  }

  // Auto-refresh switch toggle
  if (autoRefreshSwitch) {
    autoRefreshSwitch.addEventListener('change', () => {
      state.autoRefresh = autoRefreshSwitch.checked;
      if (autoRefreshLabel) {
        autoRefreshLabel.textContent = state.autoRefresh ? 'Auto-refresh (3s)' : 'Auto-refresh off';
      }
      if (state.autoRefresh) {
        startPolling();
      } else {
        stopPolling();
      }
    });
  }

  // Listen for API key updates from Settings modal
  window.addEventListener('dakghar:keys-updated', () => {
    // If keys were changed, immediately re-fetch providers & messages
    fetchProviders();
    fetchInboxMessages({ isBackground: false });
  });

  // --- Background Polling Management ---

  function startPolling() {
    stopPolling();
    if (!state.autoRefresh) return;

    state.pollTimer = setInterval(() => {
      // Avoid polling when tab is not visible or already loading
      if (document.visibilityState === 'visible' && !state.isLoading) {
        fetchInboxMessages({ isBackground: true });
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  // Pause polling when browser tab is hidden to conserve resources
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state.autoRefresh) {
        fetchInboxMessages({ isBackground: true });
        startPolling();
      }
    } else {
      stopPolling();
    }
  });

  // Clean up timers on page unload
  window.addEventListener('beforeunload', () => {
    stopPolling();
  });

  // --- Initialization ---
  fetchProviders();
  fetchInboxMessages({ isBackground: false });
  startPolling();
});
