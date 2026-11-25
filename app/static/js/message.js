/**
 * DakGhar (डाकघर) Notification Delivery Service — Message Detail Screen (Screen 3)
 *
 * Responsibilities:
 * 1. Reads the message ID from the URL query string (?id=<number>).
 * 2. Fetches full message details from GET /api/messages/{id} using the shared DakGhar.fetch().
 * 3. Renders the message overview (recipient unmasked, channel, category, subject, body,
 *    status, timestamps, attempt count).
 * 4. Renders a chronological delivery attempt timeline from attempts_log[].
 * 5. Handles all error states: missing ID, invalid ID, 404, 401, network failure.
 * 6. No polling or background refresh — this is a static detail view.
 */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // ── DOM References ────────────────────────────────────────────────────────

  const loadingState    = document.getElementById('loadingState');
  const errorState      = document.getElementById('errorState');
  const detailContent   = document.getElementById('detailContent');

  const errorTitle      = document.getElementById('errorTitle');
  const errorMessage    = document.getElementById('errorMessage');

  const pageTitle       = document.getElementById('pageTitle');
  const pageSubtitle    = document.getElementById('pageSubtitle');
  const msgIdBadge      = document.getElementById('msgIdBadge');
  const statusBadgeContainer = document.getElementById('statusBadgeContainer');

  const msgRecipient    = document.getElementById('msgRecipient');
  const subjectRow      = document.getElementById('subjectRow');
  const msgSubject      = document.getElementById('msgSubject');
  const msgBody         = document.getElementById('msgBody');

  const msgChannel      = document.getElementById('msgChannel');
  const msgCategory     = document.getElementById('msgCategory');
  const msgCreatedAt    = document.getElementById('msgCreatedAt');
  const msgSentAt       = document.getElementById('msgSentAt');
  const msgAttempts     = document.getElementById('msgAttempts');
  const msgProvider     = document.getElementById('msgProvider');
  const msgLastError    = document.getElementById('msgLastError');
  const lastErrorRow    = document.getElementById('lastErrorRow');

  const attemptCountBadge = document.getElementById('attemptCountBadge');
  const noAttemptsState   = document.getElementById('noAttemptsState');
  const attemptTimeline   = document.getElementById('attemptTimeline');

  // ── Step 1: Parse the message ID from the URL ─────────────────────────────
  //
  // The Outbox links to: message.html?id=<number>
  // We read that parameter here. If it's missing or not a positive integer,
  // we immediately show a helpful error without hitting the API.

  const urlParams = new URLSearchParams(window.location.search);
  const rawId = urlParams.get('id');
  const messageId = rawId && /^\d+$/.test(rawId.trim()) ? parseInt(rawId.trim(), 10) : null;

  if (!messageId || messageId < 1) {
    showError(
      'Invalid Message ID',
      rawId
        ? `"${rawId}" is not a valid message ID. Message IDs must be positive integers.`
        : 'No message ID was provided in the URL. Please return to the Outbox and click a message row.'
    );
    return; // Stop here — no API call needed
  }

  // ── Step 2: Fetch the message detail from the backend ─────────────────────
  //
  // Uses the shared DakGhar.fetch() which automatically attaches X-Api-Key,
  // handles 401 auth toasts, and throws on non-2xx responses.

  loadMessage(messageId);

  async function loadMessage(id) {
    try {
      const msg = await DakGhar.fetch(`/api/messages/${id}`);
      renderMessage(msg);
    } catch (err) {
      if (err && err.status === 404) {
        showError(
          'Message Not Found',
          `Message #${id} does not exist. It may have been deleted, or you may have followed an outdated link.`
        );
      } else if (err && err.status === 401) {
        // The shared api.js already shows the auth toast.
        // We show an inline error state too so the page isn't blank.
        showError(
          'Authentication Required',
          'Please configure your Sender API Key in Settings, then refresh this page.'
        );
      } else if (err && err.status === 403) {
        showError(
          'Permission Denied',
          'Your API key does not have permission to view this message.'
        );
      } else {
        // Network failure or unexpected server error
        const detail = (err && err.data && err.data.detail) || (err && err.message) || 'An unexpected error occurred.';
        showError('Failed to Load Message', detail);
      }
    }
  }

  // ── Step 3: Render the message overview and attempt timeline ──────────────

  function renderMessage(msg) {
    // Update the page title to show the message ID
    pageTitle.textContent = `Message #${msg.id}`;
    pageSubtitle.textContent = `${msg.channel.toUpperCase()} · ${msg.category} · ${msg.status}`;
    msgIdBadge.textContent = `#${msg.id}`;

    // Status badge (matches Outbox badge styling exactly)
    statusBadgeContainer.appendChild(createStatusBadge(msg.status));

    // Recipient — displayed in full (unmasked) on the detail screen, per PRD
    msgRecipient.textContent = msg.recipient || '—';

    // Subject — only relevant for email; hide the row for SMS
    if (msg.subject) {
      msgSubject.textContent = msg.subject;
    } else {
      subjectRow.classList.add('d-none');
    }

    // Message body
    msgBody.textContent = msg.body || '—';

    // Channel with icon
    const channelIcon = document.createElement('i');
    channelIcon.className = msg.channel === 'email'
      ? 'bi bi-envelope-fill me-1 text-primary'
      : 'bi bi-chat-dots-fill me-1 text-success';
    const channelText = document.createTextNode(msg.channel.toUpperCase());
    msgChannel.replaceChildren(channelIcon, channelText);

    // Category badge
    const catBadge = document.createElement('span');
    catBadge.className = msg.category === 'transactional'
      ? 'badge badge-cat-transactional'
      : 'badge badge-cat-marketing';
    catBadge.textContent = msg.category;
    msgCategory.replaceChildren(catBadge);

    // Created timestamp
    msgCreatedAt.textContent = DakGhar.formatDateTime(msg.created_at);
    msgCreatedAt.title = DakGhar.formatAge(msg.created_at);

    // Sent timestamp (null when not yet sent)
    msgSentAt.textContent = msg.sent_at ? DakGhar.formatDateTime(msg.sent_at) : '—';

    // Attempt count
    msgAttempts.textContent = String(msg.attempts || 0);

    // Last successful/attempted provider
    if (msg.provider) {
      const providerBadge = document.createElement('span');
      providerBadge.className = 'badge badge-provider';
      providerBadge.textContent = msg.provider;
      msgProvider.replaceChildren(providerBadge);
    } else {
      msgProvider.textContent = '—';
    }

    // Last error (only show row if there is one)
    if (msg.last_error) {
      msgLastError.textContent = msg.last_error;
    } else {
      lastErrorRow.classList.add('d-none');
    }

    // Render the attempt timeline
    renderAttempts(msg.attempts_log || []);

    // Now reveal the content and hide the loading spinner
    loadingState.classList.add('d-none');
    detailContent.classList.remove('d-none');
  }

  // ── Step 4: Render the attempt timeline list ──────────────────────────────
  //
  // attempts_log is ordered by attempt_no (ascending) from the backend.
  // Each entry has: attempt_no, provider, at (unix seconds), result, error (nullable)
  //
  // result values: "ok" | "transient" | "permanent"
  //   ok        → delivery succeeded
  //   transient → temporary failure, worker will retry
  //   permanent → permanent failure (bounce), worker will NOT retry

  function renderAttempts(attempts) {
    attemptCountBadge.textContent = String(attempts.length);

    if (attempts.length === 0) {
      noAttemptsState.classList.remove('d-none');
      attemptTimeline.classList.add('d-none');
      return;
    }

    noAttemptsState.classList.add('d-none');
    attemptTimeline.classList.remove('d-none');
    attemptTimeline.replaceChildren(); // clear any existing entries

    attempts.forEach((attempt) => {
      const li = createAttemptItem(attempt);
      attemptTimeline.appendChild(li);
    });
  }

  /**
   * Builds one <li> for the attempt timeline.
   * Each attempt shows: number, provider, timestamp, result badge, and error (if any).
   */
  function createAttemptItem(attempt) {
    const li = document.createElement('li');
    li.className = 'attempt-item';

    // Pick accent colour and icon based on result
    const resultInfo = getResultInfo(attempt.result);
    li.setAttribute('data-result', attempt.result); // drives CSS left-border colour

    // ── Attempt number dot (the visual timeline connector) ──
    const dot = document.createElement('div');
    dot.className = 'attempt-dot';
    dot.setAttribute('aria-hidden', 'true');

    const dotIcon = document.createElement('i');
    dotIcon.className = resultInfo.iconClass;
    dot.appendChild(dotIcon);

    // ── Attempt card body ──
    const body = document.createElement('div');
    body.className = 'attempt-body';

    // Top row: "Attempt N · <Provider badge> · <timestamp>"
    const topRow = document.createElement('div');
    topRow.className = 'attempt-top-row';

    const attemptLabel = document.createElement('span');
    attemptLabel.className = 'attempt-label';
    attemptLabel.textContent = `Attempt ${attempt.attempt_no}`;

    const providerBadge = document.createElement('span');
    providerBadge.className = 'badge badge-provider ms-2';
    providerBadge.textContent = attempt.provider;

    const timestampSpan = document.createElement('span');
    timestampSpan.className = 'attempt-timestamp text-muted small ms-auto';
    timestampSpan.textContent = DakGhar.formatDateTime(attempt.at);
    timestampSpan.title = DakGhar.formatAge(attempt.at);

    topRow.appendChild(attemptLabel);
    topRow.appendChild(providerBadge);
    topRow.appendChild(timestampSpan);

    // Result row: result badge + human-readable explanation
    const resultRow = document.createElement('div');
    resultRow.className = 'attempt-result-row mt-1';

    const resultBadge = document.createElement('span');
    resultBadge.className = `badge ${resultInfo.badgeClass}`;
    resultBadge.textContent = resultInfo.label;

    const resultDesc = document.createElement('span');
    resultDesc.className = 'text-muted small ms-2';
    resultDesc.textContent = resultInfo.description;

    resultRow.appendChild(resultBadge);
    resultRow.appendChild(resultDesc);

    // Error row (only shown when the attempt has an error message)
    if (attempt.error) {
      const errorRow = document.createElement('div');
      errorRow.className = 'attempt-error-row mt-2';

      const errorIcon = document.createElement('i');
      errorIcon.className = 'bi bi-exclamation-triangle-fill text-danger me-1';
      errorIcon.setAttribute('aria-hidden', 'true');

      const errorText = document.createElement('span');
      errorText.className = 'text-danger small text-break';
      errorText.textContent = attempt.error;

      errorRow.appendChild(errorIcon);
      errorRow.appendChild(errorText);
      body.appendChild(topRow);
      body.appendChild(resultRow);
      body.appendChild(errorRow);
    } else {
      body.appendChild(topRow);
      body.appendChild(resultRow);
    }

    li.appendChild(dot);
    li.appendChild(body);
    return li;
  }

  // ── Attempt result metadata ───────────────────────────────────────────────

  function getResultInfo(result) {
    switch (result) {
      case 'ok':
        return {
          iconClass: 'bi bi-check-circle-fill',
          badgeClass: 'bg-success text-white',
          label: 'Delivered',
          description: 'Message was accepted and delivered successfully.'
        };
      case 'transient':
        return {
          iconClass: 'bi bi-arrow-repeat',
          badgeClass: 'bg-warning text-dark',
          label: 'Transient Failure',
          description: 'Temporary error — the worker will retry with another provider.'
        };
      case 'permanent':
        return {
          iconClass: 'bi bi-x-circle-fill',
          badgeClass: 'bg-danger text-white',
          label: 'Permanent Failure',
          description: 'Delivery failed permanently (e.g. bounced). No further retries.'
        };
      default:
        return {
          iconClass: 'bi bi-question-circle',
          badgeClass: 'bg-secondary text-white',
          label: result || 'Unknown',
          description: ''
        };
    }
  }

  // ── Status badge (identical logic to outbox.js createStatusBadge) ─────────

  function createStatusBadge(status) {
    const badge = document.createElement('span');
    badge.className = `badge badge-status badge-${status}`;
    badge.setAttribute('aria-label', `Status: ${status}`);

    const icon = document.createElement('i');
    if (status === 'pending') {
      icon.className = 'bi bi-clock-history';
    } else if (status === 'sending') {
      icon.className = 'bi bi-arrow-repeat';
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

  // ── Error state helper ────────────────────────────────────────────────────

  function showError(title, message) {
    loadingState.classList.add('d-none');
    detailContent.classList.add('d-none');
    errorTitle.textContent = title;
    errorMessage.textContent = message;
    errorState.classList.remove('d-none');
  }
});
