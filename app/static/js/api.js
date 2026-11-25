/**
 * DakGhar (डाकघर) Notification Delivery Service - Core API & Auth Client
 *
 * Responsibilities:
 * 1. Manages Sender Key and Admin Key in sessionStorage ('dakghar:sender_key', 'dakghar:admin_key') - tab-scoped only.
 * 2. Ensures a sender key is sent ONLY through 'X-Api-Key' and an admin key ONLY through 'X-Admin-Key'.
 *    Never sends the same key through both headers.
 * 3. Manages UI preferences in localStorage ('dakghar:prefs') with safe try/catch.
 * 4. Provides unified apiFetch() with automated headers, error handling, and server downtime toasts.
 * 5. Provides UI toast notifications and XSS-safe text rendering utilities (textContent).
 * 6. Maintains live navbar worker status indicator via public /health endpoint.
 */

const DakGhar = (function () {
  'use strict';

  const STORAGE_SENDER_KEY = 'dakghar:sender_key';
  const STORAGE_ADMIN_KEY = 'dakghar:admin_key';
  const PREFS_KEY = 'dakghar:prefs';

  // --- Session & Storage Management ---

  function getSenderKey() {
    try {
      return sessionStorage.getItem(STORAGE_SENDER_KEY) || '';
    } catch (e) {
      console.warn('sessionStorage is not accessible:', e);
      return '';
    }
  }

  function setSenderKey(key) {
    try {
      if (key && key.trim()) {
        sessionStorage.setItem(STORAGE_SENDER_KEY, key.trim());
      } else {
        sessionStorage.removeItem(STORAGE_SENDER_KEY);
      }
      authToastShown = false;
    } catch (e) {
      console.warn('Failed to write sender key to sessionStorage:', e);
    }
  }

  function getAdminKey() {
    try {
      return sessionStorage.getItem(STORAGE_ADMIN_KEY) || '';
    } catch (e) {
      console.warn('sessionStorage is not accessible:', e);
      return '';
    }
  }

  function setAdminKey(key) {
    try {
      if (key && key.trim()) {
        sessionStorage.setItem(STORAGE_ADMIN_KEY, key.trim());
      } else {
        sessionStorage.removeItem(STORAGE_ADMIN_KEY);
      }
      authToastShown = false;
    } catch (e) {
      console.warn('Failed to write admin key to sessionStorage:', e);
    }
  }

  function clearKeys() {
    try {
      sessionStorage.removeItem(STORAGE_SENDER_KEY);
      sessionStorage.removeItem(STORAGE_ADMIN_KEY);
      authToastShown = false;
    } catch (e) {
      console.warn('Failed to clear keys from sessionStorage:', e);
    }
  }

  function getPrefs() {
    try {
      const data = localStorage.getItem(PREFS_KEY);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      console.warn('Failed to read localStorage preferences:', e);
      return {};
    }
  }

  function savePrefs(newPrefs) {
    try {
      const current = getPrefs();
      const updated = Object.assign({}, current, newPrefs);
      localStorage.setItem(PREFS_KEY, JSON.stringify(updated));
      return updated;
    } catch (e) {
      console.warn('Failed to save preferences to localStorage:', e);
      return {};
    }
  }

  function clearPrefs() {
    try {
      localStorage.removeItem(PREFS_KEY);
    } catch (e) {
      console.warn('Failed to clear preferences:', e);
    }
  }

  // --- Safe DOM / Output Utilities (XSS Prevention) ---

  function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function setText(elementOrId, text) {
    const el = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
    if (el) {
      el.textContent = text !== null && text !== undefined ? String(text) : '';
    }
  }

  // Format relative timestamp (e.g. "3 seconds ago", "2 minutes ago")
  function formatAge(unixSeconds) {
    if (!unixSeconds) return '-';
    const now = Date.now() / 1000;
    const diff = Math.max(0, Math.floor(now - unixSeconds));
    if (diff < 2) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(diff / 3600);
    if (hours < 24) return `${hours}h ago`;
    // For timestamps older than 24 hours, show full date and time
    return formatDateTime(unixSeconds);
  }

  // Format full date time string
  function formatDateTime(unixSeconds) {
    if (!unixSeconds) return '-';
    return new Date(unixSeconds * 1000).toLocaleString();
  }

  // Mask recipient for sender view (r***@shop.example, +91 98•••• 5678)
  function maskRecipient(recipient) {
    if (!recipient) return '-';
    if (recipient.includes('@')) {
      const parts = recipient.split('@');
      const user = parts[0];
      const domain = parts[1] || '';
      const maskedUser = user.length > 1 ? user[0] + '***' : '***';
      return `${maskedUser}@${domain}`;
    }
    // Phone number format
    if (recipient.startsWith('+') && recipient.length > 7) {
      const country = recipient.slice(0, 3);
      const prefix = recipient.slice(3, 5);
      const suffix = recipient.slice(-4);
      return `${country} ${prefix}•••• ${suffix}`;
    }
    return recipient;
  }

  // --- Toast Notification System ---

  function showToast(message, type = 'info', action = null) {
    let container = document.getElementById('dg-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'dg-toast-container';
      container.className = 'toast-container-fixed';
      document.body.appendChild(container);
    }

    // Deduplicate: avoid stacking identical active toasts
    const existingToasts = container.querySelectorAll('.toast');
    for (const t of existingToasts) {
      const bodyEl = t.querySelector('.toast-body');
      if (bodyEl && bodyEl.textContent === message) {
        return;
      }
    }

    const toastId = 'toast-' + Math.random().toString(36).substring(2, 9);
    const bgClass = type === 'success' ? 'bg-success text-white' :
                    type === 'error' ? 'bg-danger text-white' :
                    type === 'warning' ? 'bg-warning text-dark' : 'bg-primary text-white';

    const toastEl = document.createElement('div');
    toastEl.id = toastId;
    toastEl.className = `toast align-items-center ${bgClass} border-0 mb-2`;
    toastEl.setAttribute('role', 'alert');
    toastEl.setAttribute('aria-live', 'assertive');
    toastEl.setAttribute('aria-atomic', 'true');

    const wrapper = document.createElement('div');
    wrapper.className = 'd-flex';

    // Requirement 5: Using textContent to prevent unsafe HTML injection
    const body = document.createElement('div');
    body.className = 'toast-body flex-grow-1';
    body.textContent = message;

    if (action && action.label && action.onClick) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-outline-light ms-2 py-0 px-2';
      btn.textContent = action.label;
      btn.onclick = (e) => {
        e.preventDefault();
        action.onClick();
      };
      body.appendChild(btn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = `btn-close ${type === 'warning' ? '' : 'btn-close-white'} me-2 m-auto`;
    closeBtn.setAttribute('data-bs-dismiss', 'toast');
    closeBtn.setAttribute('aria-label', 'Close');

    wrapper.appendChild(body);
    wrapper.appendChild(closeBtn);
    toastEl.appendChild(wrapper);
    container.appendChild(toastEl);

    if (window.bootstrap && window.bootstrap.Toast) {
      const bsToast = new window.bootstrap.Toast(toastEl, { delay: type === 'error' ? 8000 : 4000 });
      bsToast.show();
      toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
    } else {
      setTimeout(() => toastEl.remove(), 4000);
    }
  }

  // --- Network Request Helper ---

  let serverDownToastShown = false;
  let authToastShown = false;

  // Identify admin mutation endpoints
  function isAdminEndpoint(endpoint, method) {
    const m = (method || 'GET').toUpperCase();
    if (m === 'PATCH' && endpoint.startsWith('/api/worker')) return true;
    if (m === 'POST' && endpoint === '/api/worker/tick') return true;
    if (m === 'PATCH' && endpoint.startsWith('/api/providers/')) return true;
    if (m === 'POST' && endpoint === '/api/admin/reset') return true;
    return false;
  }

  /**
   * Requirement 4:
   * - Sender key is sent ONLY through 'X-Api-Key'.
   * - Admin key is sent ONLY through 'X-Admin-Key'.
   * - Never sends the same key through both headers.
   */
  async function apiFetch(endpoint, options = {}) {
    const senderKey = getSenderKey();
    const adminKey = getAdminKey();
    const headers = Object.assign({}, options.headers || {});
    const method = options.method || 'GET';

    // Public /health endpoint receives no auth headers
    if (endpoint === '/health' || endpoint.startsWith('/health')) {
      // No key attached for public health check
    } else if (isAdminEndpoint(endpoint, method)) {
      // Admin mutation endpoint: send X-Admin-Key only
      if (adminKey) {
        headers['X-Admin-Key'] = adminKey;
      }
    } else {
      // Sender endpoint: send X-Api-Key only
      if (senderKey) {
        headers['X-Api-Key'] = senderKey;
      }
    }

    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const fetchConfig = Object.assign({}, options, { headers });

    // 1. Network fetch: only network failures trigger the server-offline toast
    let response;
    try {
      response = await fetch(endpoint, fetchConfig);
    } catch (networkErr) {
      if (!serverDownToastShown) {
        serverDownToastShown = true;
        showToast('Server not reachable. Is uvicorn running?', 'error', {
          label: 'Retry',
          onClick: () => apiFetch(endpoint, options)
        });
      }
      throw networkErr;
    }

    if (serverDownToastShown) {
      serverDownToastShown = false;
      showToast('Connected back to DakGhar server', 'success');
    }

    // 2. Response body processing: parsing errors are not classified as server connection failures
    let data = null;
    const contentType = response.headers.get('content-type') || '';
    try {
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }
    } catch (parseErr) {
      console.warn('Failed to parse response body as JSON:', parseErr);
      data = null;
    }

    // 3. HTTP status error handling
    if (!response.ok) {
      const errorDetail = (data && data.detail) || (data && data.error) || response.statusText;
      const err = new Error(typeof errorDetail === 'string' ? errorDetail : JSON.stringify(errorDetail));
      err.status = response.status;
      err.data = data;

      if (response.status === 401) {
        if (!options.silentAuth && (!authToastShown || options.forceAuthToast)) {
          authToastShown = true;
          showToast('API key missing or required. Please configure it in Settings.', 'warning');
        }
      } else if (response.status === 403) {
        if (!options.silentAuth) {
          showToast('Permission denied (403): Operation requires higher privileges.', 'error');
        }
      }

      throw err;
    }

    // Reset auth toast flag ONLY on successful responses from authenticated endpoints
    // Public endpoints like /health must NEVER reset authToastShown
    if (authToastShown && endpoint !== '/health' && !endpoint.startsWith('/health')) {
      authToastShown = false;
    }

    return data;
  }

  // --- Health & Worker Status Indicator ---

  async function checkHealth() {
    try {
      const health = await apiFetch('/health');
      const pulseElements = document.querySelectorAll('.worker-pulse');
      const textElements = document.querySelectorAll('.worker-status-text');

      pulseElements.forEach(el => {
        el.className = 'worker-pulse ' + (health.worker === 'running' ? 'running' : 'paused');
      });

      textElements.forEach(el => {
        el.textContent = health.worker === 'running' ? 'Worker Running' : 'Worker Paused';
      });

      return health;
    } catch (e) {
      const pulseElements = document.querySelectorAll('.worker-pulse');
      const textElements = document.querySelectorAll('.worker-status-text');
      pulseElements.forEach(el => { el.className = 'worker-pulse paused'; });
      textElements.forEach(el => { el.textContent = 'Server Offline'; });
      return null;
    }
  }

  function startHealthMonitoring(intervalMs = 6000) {
    checkHealth();
    return setInterval(checkHealth, intervalMs);
  }

  // --- Settings Modal Handler ---

  function initSettingsModal() {
    const senderKeyInput = document.getElementById('settingsSenderKeyInput');
    const adminKeyInput = document.getElementById('settingsAdminKeyInput');
    const saveBtn = document.getElementById('settingsSaveBtn');
    const clearKeysBtn = document.getElementById('settingsClearKeysBtn');
    const clearPrefsBtn = document.getElementById('settingsClearPrefsBtn');
    const senderBadge = document.getElementById('settingsSenderBadge');
    const adminBadge = document.getElementById('settingsAdminBadge');

    function updateDisplay() {
      const sKey = getSenderKey();
      const aKey = getAdminKey();

      if (senderKeyInput) senderKeyInput.value = sKey;
      if (adminKeyInput) adminKeyInput.value = aKey;

      if (senderBadge) {
        if (sKey) {
          senderBadge.textContent = 'Sender Key Active';
          senderBadge.className = 'badge bg-success';
        } else {
          senderBadge.textContent = 'No Sender Key';
          senderBadge.className = 'badge bg-secondary';
        }
      }

      if (adminBadge) {
        if (aKey) {
          adminBadge.textContent = 'Admin Key Active';
          adminBadge.className = 'badge bg-success';
        } else {
          adminBadge.textContent = 'No Admin Key';
          adminBadge.className = 'badge bg-secondary';
        }
      }
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const sVal = senderKeyInput ? senderKeyInput.value.trim() : '';
        const aVal = adminKeyInput ? adminKeyInput.value.trim() : '';

        setSenderKey(sVal);
        setAdminKey(aVal);

        updateDisplay();
        showToast('API keys saved for this browser session.', 'success');

        window.dispatchEvent(new CustomEvent('dakghar:keys-updated'));

        const modalEl = document.getElementById('settingsModal');
        if (modalEl && window.bootstrap && window.bootstrap.Modal) {
          const modalInstance = window.bootstrap.Modal.getInstance(modalEl);
          if (modalInstance) modalInstance.hide();
        }
      });
    }

    if (clearKeysBtn) {
      clearKeysBtn.addEventListener('click', () => {
        clearKeys();
        if (senderKeyInput) senderKeyInput.value = '';
        if (adminKeyInput) adminKeyInput.value = '';
        updateDisplay();
        showToast('API keys cleared from session.', 'info');
        window.dispatchEvent(new CustomEvent('dakghar:keys-updated'));
      });
    }

    if (clearPrefsBtn) {
      clearPrefsBtn.addEventListener('click', () => {
        clearPrefs();
        showToast('Local display preferences cleared.', 'info');
      });
    }

    const modalEl = document.getElementById('settingsModal');
    if (modalEl) {
      modalEl.addEventListener('show.bs.modal', updateDisplay);
    }

    updateDisplay();
  }

  // Auto initialize on DOM ready
  document.addEventListener('DOMContentLoaded', () => {
    initSettingsModal();
    startHealthMonitoring();
  });

  // Public exports
  return {
    getSenderKey,
    setSenderKey,
    getAdminKey,
    setAdminKey,
    clearKeys,
    getPrefs,
    savePrefs,
    clearPrefs,
    escapeHTML,
    setText,
    formatAge,
    formatDateTime,
    maskRecipient,
    showToast,
    fetch: apiFetch,
    checkHealth,
    startHealthMonitoring,
    initSettingsModal,
    resetAuthToast: () => { authToastShown = false; }
  };
})();
