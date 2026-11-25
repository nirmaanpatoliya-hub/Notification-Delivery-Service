/**
 * DakGhar (डाकघर) Notification Delivery Service - Screen 4: Providers & Worker Controls
 *
 * Responsibilities:
 * 1. Fetches and displays live worker status (Running/Paused, processed total, recovered count, last tick).
 * 2. Provides worker execution controls (Pause / Resume worker, Run One Tick) via PATCH /api/worker and POST /api/worker/tick.
 * 3. Fetches and renders mock providers (mailfast, postbird, smsly, textgo) grouped cleanly by channel (Email vs SMS).
 * 4. Provides provider controls (Outage switch toggle, Failure rate range slider 0%-50% with Apply button).
 * 5. Strict role enforcement: If only Sender Key is configured, controls are read-only with an admin key notice banner.
 *    If Admin Key (X-Admin-Key) is configured, administrative controls are enabled.
 * 6. Live cooldown countdown timer without unnecessary API requests every second.
 * 7. Non-overlapping auto-refresh when tab is visible, preserving user's in-progress slider adjustments.
 * 8. Top-level executive KPI indicators for channel routing health and worker throughput.
 */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // --- Configuration & Constants ---
  const POLL_INTERVAL_MS = 5000; // 5-second polling interval for provider/worker dashboard

  // --- State ---
  const state = {
    worker: null,
    providers: [],
    hasAdminKey: false,
    hasSenderKey: false,
    isFetching: false,
    pollTimer: null,
    cooldownTimer: null,
    // Store in-progress slider values so polling doesn't overwrite while user is dragging
    editingSliders: new Map() // providerName -> percentage (0 to 50)
  };

  // --- DOM Elements ---
  const refreshBtn = document.getElementById('refreshBtn');
  const refreshIcon = document.getElementById('refreshIcon');
  const adminNotice = document.getElementById('adminNotice');
  const adminActiveBadge = document.getElementById('adminActiveBadge');
  const loadingState = document.getElementById('loadingState');
  const dashboardContent = document.getElementById('dashboardContent');

  // Executive KPI Elements
  const kpiWorkerState = document.getElementById('kpiWorkerState');
  const kpiWorkerSubtitle = document.getElementById('kpiWorkerSubtitle');
  const kpiProcessedTotal = document.getElementById('kpiProcessedTotal');
  const kpiRecoveredTotal = document.getElementById('kpiRecoveredTotal');
  const kpiEmailRouting = document.getElementById('kpiEmailRouting');
  const kpiEmailSub = document.getElementById('kpiEmailSub');
  const kpiSmsRouting = document.getElementById('kpiSmsRouting');
  const kpiSmsSub = document.getElementById('kpiSmsSub');

  // Worker DOM Elements
  const workerStateBadge = document.getElementById('workerStateBadge');
  const workerStateText = document.getElementById('workerStateText');
  const workerStateSub = document.getElementById('workerStateSub');
  const workerProcessedTotal = document.getElementById('workerProcessedTotal');
  const workerRecoveredTotal = document.getElementById('workerRecoveredTotal');
  const workerLastTickTime = document.getElementById('workerLastTickTime');
  const workerLastTickAge = document.getElementById('workerLastTickAge');
  const toggleWorkerBtn = document.getElementById('toggleWorkerBtn');
  const toggleWorkerSpinner = document.getElementById('toggleWorkerSpinner');
  const toggleWorkerIcon = document.getElementById('toggleWorkerIcon');
  const toggleWorkerText = document.getElementById('toggleWorkerText');
  const runTickBtn = document.getElementById('runTickBtn');
  const runTickSpinner = document.getElementById('runTickSpinner');
  const runTickIcon = document.getElementById('runTickIcon');
  const runTickText = document.getElementById('runTickText');

  // Provider Grids
  const emailProvidersGrid = document.getElementById('emailProvidersGrid');
  const smsProvidersGrid = document.getElementById('smsProvidersGrid');
  const providersGrid = document.getElementById('providersGrid');

  // --- Authentication & Role Detection ---

  function checkRole() {
    const adminKey = DakGhar.getAdminKey();
    const senderKey = DakGhar.getSenderKey();

    state.hasAdminKey = Boolean(adminKey && adminKey.trim());
    state.hasSenderKey = Boolean(senderKey && senderKey.trim());

    if (state.hasAdminKey) {
      if (adminNotice) adminNotice.classList.add('d-none');
      if (adminActiveBadge) adminActiveBadge.classList.remove('d-none');
    } else {
      if (adminNotice) adminNotice.classList.remove('d-none');
      if (adminActiveBadge) adminActiveBadge.classList.add('d-none');
    }

    // Enable or disable worker buttons based on Admin role
    if (toggleWorkerBtn) toggleWorkerBtn.disabled = !state.hasAdminKey;
    if (runTickBtn) runTickBtn.disabled = !state.hasAdminKey;

    // Update title tooltips on controls when disabled
    if (!state.hasAdminKey) {
      if (toggleWorkerBtn) toggleWorkerBtn.title = 'Admin Key required to control worker';
      if (runTickBtn) runTickBtn.title = 'Admin Key required to trigger worker tick';
    } else {
      if (toggleWorkerBtn) toggleWorkerBtn.removeAttribute('title');
      if (runTickBtn) runTickBtn.removeAttribute('title');
    }
  }

  // --- Data Fetching ---

  async function fetchDashboardData({ isInitial = false } = {}) {
    if (state.isFetching) return;
    state.isFetching = true;

    try {
      // Parallel fetch for worker state and providers list
      const [workerData, providersData] = await Promise.all([
        DakGhar.fetch('/api/worker', { silentAuth: !isInitial }),
        DakGhar.fetch('/api/providers', { silentAuth: !isInitial })
      ]);

      state.worker = workerData;
      state.providers = providersData || [];

      renderWorkerStatus(workerData);
      renderProvidersList(state.providers);
      updateExecutiveKpis(workerData, state.providers);

      if (loadingState) loadingState.classList.add('d-none');
      if (dashboardContent) dashboardContent.classList.remove('d-none');

    } catch (err) {
      console.warn('Failed to load providers/worker data:', err);
      // If initial fetch failed, ensure user gets feedback
      if (isInitial && (!state.hasSenderKey && !state.hasAdminKey)) {
        if (loadingState) loadingState.classList.add('d-none');
        if (dashboardContent) dashboardContent.classList.remove('d-none');
      }
    } finally {
      state.isFetching = false;
    }
  }

  // --- Update Top Executive KPI Cards ---

  function updateExecutiveKpis(worker, providers) {
    if (!worker || !providers) return;

    // 1. Worker KPI
    const isPaused = Boolean(worker.paused);
    if (kpiWorkerState) {
      kpiWorkerState.textContent = isPaused ? 'Paused' : 'Running';
      kpiWorkerState.className = isPaused ? 'count-number mt-1 text-warning' : 'count-number mt-1 text-success';
    }
    if (kpiWorkerSubtitle) {
      kpiWorkerSubtitle.textContent = isPaused ? 'Background loop suspended' : '1.0s background tick loop';
    }

    // 2. Throughput KPI
    if (kpiProcessedTotal) {
      kpiProcessedTotal.textContent = Number(worker.processed_total || 0).toLocaleString();
    }
    if (kpiRecoveredTotal) {
      kpiRecoveredTotal.textContent = `${Number(worker.recovered_on_start || 0).toLocaleString()} recovered on start`;
    }

    // 3. Email Channel Health
    const now = Date.now() / 1000;
    const emailProviders = providers.filter(p => p.channel === 'email');
    const mailfast = emailProviders.find(p => p.name === 'mailfast');
    const postbird = emailProviders.find(p => p.name === 'postbird');

    if (mailfast && postbird && kpiEmailRouting && kpiEmailSub) {
      const mfHealthy = !mailfast.outage && (!mailfast.open_until || mailfast.open_until <= now);
      const pbHealthy = !postbird.outage && (!postbird.open_until || postbird.open_until <= now);

      if (mfHealthy) {
        kpiEmailRouting.textContent = 'Healthy';
        kpiEmailRouting.className = 'count-number mt-1 text-success';
        kpiEmailSub.textContent = 'Primary (mailfast) active';
      } else if (pbHealthy) {
        kpiEmailRouting.textContent = 'Failover Active';
        kpiEmailRouting.className = 'count-number mt-1 text-warning';
        kpiEmailSub.textContent = 'Backup (postbird) active';
      } else {
        kpiEmailRouting.textContent = 'All Cooling Down';
        kpiEmailRouting.className = 'count-number mt-1 text-danger';
        kpiEmailSub.textContent = 'Messages queuing until cooldown';
      }
    }

    // 4. SMS Channel Health
    const smsProviders = providers.filter(p => p.channel === 'sms');
    const smsly = smsProviders.find(p => p.name === 'smsly');
    const textgo = smsProviders.find(p => p.name === 'textgo');

    if (smsly && textgo && kpiSmsRouting && kpiSmsSub) {
      const smsHealthy = !smsly.outage && (!smsly.open_until || smsly.open_until <= now);
      const tgHealthy = !textgo.outage && (!textgo.open_until || textgo.open_until <= now);

      if (smsHealthy) {
        kpiSmsRouting.textContent = 'Healthy';
        kpiSmsRouting.className = 'count-number mt-1 text-purple';
        kpiSmsSub.textContent = 'Primary (smsly) active';
      } else if (tgHealthy) {
        kpiSmsRouting.textContent = 'Failover Active';
        kpiSmsRouting.className = 'count-number mt-1 text-warning';
        kpiSmsSub.textContent = 'Backup (textgo) active';
      } else {
        kpiSmsRouting.textContent = 'All Cooling Down';
        kpiSmsRouting.className = 'count-number mt-1 text-danger';
        kpiSmsSub.textContent = 'Messages queuing until cooldown';
      }
    }
  }

  // --- Render Worker Status & Controls ---

  function renderWorkerStatus(worker) {
    if (!worker) return;

    const isPaused = Boolean(worker.paused);

    // 1. Worker Header Badge
    if (workerStateBadge) {
      if (isPaused) {
        workerStateBadge.className = 'badge badge-status badge-pending';
        workerStateBadge.innerHTML = '<span class="worker-pulse paused"></span><span>Paused</span>';
      } else {
        workerStateBadge.className = 'badge badge-status badge-sent';
        workerStateBadge.innerHTML = '<span class="worker-pulse running"></span><span>Running</span>';
      }
    }

    // 2. Worker Stats Row
    if (workerStateText) {
      workerStateText.textContent = isPaused ? 'Paused' : 'Running';
      workerStateText.className = isPaused ? 'stat-value text-warning' : 'stat-value text-success';
    }
    if (workerStateSub) {
      workerStateSub.textContent = isPaused ? 'Background loop suspended' : '1 tick every second';
    }

    if (workerProcessedTotal) {
      workerProcessedTotal.textContent = Number(worker.processed_total || 0).toLocaleString();
    }
    if (workerRecoveredTotal) {
      workerRecoveredTotal.textContent = Number(worker.recovered_on_start || 0).toLocaleString();
    }

    if (workerLastTickTime && workerLastTickAge) {
      if (worker.last_tick_at) {
        workerLastTickTime.textContent = DakGhar.formatDateTime(worker.last_tick_at);
        workerLastTickAge.textContent = `(${DakGhar.formatAge(worker.last_tick_at)})`;
      } else {
        workerLastTickTime.textContent = 'None';
        workerLastTickAge.textContent = 'No ticks recorded yet';
      }
    }

    // 3. Toggle Button Text & Icon
    if (toggleWorkerBtn && toggleWorkerIcon && toggleWorkerText) {
      if (isPaused) {
        toggleWorkerIcon.className = 'bi bi-play-fill';
        toggleWorkerText.textContent = 'Resume Worker';
        toggleWorkerBtn.className = 'btn btn-sm btn-outline-success d-inline-flex align-items-center gap-2';
      } else {
        toggleWorkerIcon.className = 'bi bi-pause-fill';
        toggleWorkerText.textContent = 'Pause Worker';
        toggleWorkerBtn.className = 'btn btn-sm btn-outline-warning d-inline-flex align-items-center gap-2';
      }
      toggleWorkerBtn.disabled = !state.hasAdminKey;
    }

    if (runTickBtn) {
      runTickBtn.disabled = !state.hasAdminKey;
    }
  }

  // --- Render Provider Cards Grouped by Channel ---

  function renderProvidersList(providers) {
    if (!providers || providers.length === 0) return;

    // Sort providers by priority (Primary = 1 first, Backup = 2 second)
    const sortedProviders = providers.slice().sort((a, b) => (a.priority || 1) - (b.priority || 1));

    sortedProviders.forEach(p => {
      let cardCol = document.getElementById(`provider-col-${p.name}`);

      // Determine destination container based on channel
      let targetContainer = null;
      if (p.channel === 'email' && emailProvidersGrid) {
        targetContainer = emailProvidersGrid;
      } else if (p.channel === 'sms' && smsProvidersGrid) {
        targetContainer = smsProvidersGrid;
      } else if (providersGrid) {
        targetContainer = providersGrid;
      }

      if (!cardCol) {
        // Create new card column
        cardCol = createProviderCard(p);
        if (targetContainer) {
          targetContainer.appendChild(cardCol);
        }
      } else {
        // Update existing card in-place
        updateProviderCard(cardCol, p);
      }
    });
  }

  function getProviderStateInfo(p) {
    const now = Date.now() / 1000;
    const isOutage = Boolean(p.outage);
    const isCooldown = !isOutage && Boolean(p.open_until && p.open_until > now);

    if (isOutage) {
      return {
        status: 'outage',
        badgeClass: 'bg-danger text-white',
        cardClass: 'provider-state-outage',
        iconClass: 'bi bi-slash-circle-fill',
        label: 'Outage Simulated'
      };
    } else if (isCooldown) {
      const remaining = Math.max(0, Math.ceil(p.open_until - now));
      return {
        status: 'cooldown',
        badgeClass: 'bg-warning text-dark',
        cardClass: 'provider-state-cooldown',
        iconClass: 'bi bi-hourglass-split',
        label: `Cooling Down (${remaining}s)`,
        remaining: remaining
      };
    } else {
      return {
        status: 'healthy',
        badgeClass: 'bg-success text-white',
        cardClass: 'provider-state-healthy',
        iconClass: 'bi bi-check-circle-fill',
        label: 'Healthy'
      };
    }
  }

  function createProviderCard(p) {
    const col = document.createElement('div');
    col.id = `provider-col-${p.name}`;
    col.className = 'col-12 col-md-6';

    const card = document.createElement('div');
    card.id = `provider-card-${p.name}`;
    card.className = 'card h-100 provider-card shadow-sm border';

    const stateInfo = getProviderStateInfo(p);
    card.classList.add(stateInfo.cardClass);

    // --- Card Header ---
    const header = document.createElement('div');
    header.className = 'card-header bg-white py-3 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom';

    // Provider Title Left
    const titleLeft = document.createElement('div');
    titleLeft.className = 'd-flex align-items-center gap-2 flex-wrap';

    const nameBadge = document.createElement('span');
    nameBadge.className = 'badge badge-provider fs-6 text-uppercase fw-bold px-2 py-1';
    nameBadge.textContent = p.name;
    titleLeft.appendChild(nameBadge);

    // Route / Priority badge with icon
    const priorityBadge = document.createElement('span');
    if (p.priority === 1) {
      priorityBadge.className = 'badge bg-primary-subtle text-primary border border-primary-subtle small d-inline-flex align-items-center gap-1';
      priorityBadge.innerHTML = '<i class="bi bi-star-fill text-warning"></i><span>Primary Route</span>';
    } else {
      priorityBadge.className = 'badge bg-light text-secondary border small d-inline-flex align-items-center gap-1';
      priorityBadge.innerHTML = '<i class="bi bi-shield-check text-info"></i><span>Backup Standby</span>';
    }
    titleLeft.appendChild(priorityBadge);

    // State Badge Right
    const stateBadge = document.createElement('span');
    stateBadge.className = `badge ${stateInfo.badgeClass} provider-status-badge d-flex align-items-center gap-1`;
    stateBadge.id = `provider-status-${p.name}`;
    stateBadge.innerHTML = `<i class="${stateInfo.iconClass}"></i><span class="status-label">${stateInfo.label}</span>`;

    header.appendChild(titleLeft);
    header.appendChild(stateBadge);
    card.appendChild(header);

    // --- Card Body ---
    const body = document.createElement('div');
    body.className = 'card-body p-3 d-flex flex-column justify-content-between';

    // Stats Grid inside Card
    const statsGrid = document.createElement('div');
    statsGrid.className = 'row g-2 mb-3';

    // Consecutive Failures
    const colFailures = document.createElement('div');
    colFailures.className = 'col-6';
    colFailures.innerHTML = `
      <div class="provider-stat-item p-2 rounded bg-light border h-100">
        <div class="small text-muted mb-1">Consecutive Failures</div>
        <div class="fw-bold font-monospace fs-6" id="provider-consecutive-${p.name}">${p.consecutive_failures || 0} / 2</div>
        <div class="circuit-meter mt-1 d-flex gap-1" id="circuit-meter-${p.name}">
          <div class="circuit-pip ${p.consecutive_failures >= 1 ? 'pip-warn' : ''}"></div>
          <div class="circuit-pip ${p.consecutive_failures >= 2 ? 'pip-danger' : ''}"></div>
        </div>
        <div class="stat-mini-note text-muted mt-1">Trips circuit at 2</div>
      </div>
    `;

    // Circuit Breaker Status
    const colCircuit = document.createElement('div');
    colCircuit.className = 'col-6';
    colCircuit.innerHTML = `
      <div class="provider-stat-item p-2 rounded bg-light border h-100">
        <div class="small text-muted mb-1">Circuit Breaker</div>
        <div class="fw-bold fs-6" id="provider-circuit-${p.name}">
          ${stateInfo.status === 'cooldown' ? 'Cooling Down' : 'Closed (Healthy)'}
        </div>
        <div class="stat-mini-note text-muted mt-2" id="provider-open-until-${p.name}">
          ${p.open_until && p.open_until > (Date.now() / 1000) ? '30s cooldown timer active' : 'Normal dispatch'}
        </div>
      </div>
    `;

    statsGrid.appendChild(colFailures);
    statsGrid.appendChild(colCircuit);
    body.appendChild(statsGrid);

    // Controls Box (Outage Toggle & Failure-Rate Slider)
    const controlsBox = document.createElement('div');
    controlsBox.className = 'provider-controls-box p-3 rounded border bg-light';

    // 1. Outage Switch Toggle
    const outageWrapper = document.createElement('div');
    outageWrapper.className = 'form-check form-switch mb-3 pb-2 border-bottom';

    const outageInput = document.createElement('input');
    outageInput.className = 'form-check-input provider-outage-switch';
    outageInput.type = 'checkbox';
    outageInput.role = 'switch';
    outageInput.id = `outage-switch-${p.name}`;
    outageInput.checked = Boolean(p.outage);
    outageInput.disabled = !state.hasAdminKey;

    const outageLabel = document.createElement('label');
    outageLabel.className = 'form-check-label fw-semibold small d-flex justify-content-between align-items-center w-100';
    outageLabel.htmlFor = `outage-switch-${p.name}`;
    outageLabel.innerHTML = `
      <span>Simulate Outage</span>
      <span class="badge ${p.outage ? 'bg-danger' : 'bg-secondary'} small" id="outage-state-badge-${p.name}">
        ${p.outage ? 'Outage Active' : 'Normal'}
      </span>
    `;

    const outageHelp = document.createElement('div');
    outageHelp.className = 'text-muted small mt-1';
    outageHelp.textContent = 'When enabled, provider immediately returns 503 Provider Unavailable on next send.';

    outageWrapper.appendChild(outageInput);
    outageWrapper.appendChild(outageLabel);
    outageWrapper.appendChild(outageHelp);
    controlsBox.appendChild(outageWrapper);

    // 2. Failure Rate Slider (0% to 50%)
    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'slider-control-group';

    const currentPercent = Math.round((p.fail_rate || 0) * 100);

    const sliderHeader = document.createElement('div');
    sliderHeader.className = 'd-flex justify-content-between align-items-center mb-1';
    sliderHeader.innerHTML = `
      <label class="form-label small fw-semibold mb-0" for="slider-${p.name}">Random Timeout / Fail Rate</label>
      <span class="badge bg-white text-dark border font-monospace shadow-sm" id="slider-val-badge-${p.name}">${currentPercent}%</span>
    `;

    const sliderRow = document.createElement('div');
    sliderRow.className = 'd-flex align-items-center gap-2 mb-1';

    const rangeInput = document.createElement('input');
    rangeInput.type = 'range';
    rangeInput.className = 'form-range flex-grow-1 provider-fail-slider';
    rangeInput.id = `slider-${p.name}`;
    rangeInput.min = '0';
    rangeInput.max = '50';
    rangeInput.step = '1';
    rangeInput.value = String(currentPercent);
    rangeInput.disabled = !state.hasAdminKey;

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn btn-sm btn-outline-primary px-3 py-1';
    applyBtn.id = `apply-btn-${p.name}`;
    applyBtn.textContent = 'Apply';
    applyBtn.disabled = true; // Disabled until slider moves

    sliderRow.appendChild(rangeInput);
    sliderRow.appendChild(applyBtn);

    const sliderLabels = document.createElement('div');
    sliderLabels.className = 'd-flex justify-content-between text-muted small slider-range-labels';
    sliderLabels.innerHTML = '<span>0% (Stable)</span><span>25%</span><span>50% (Max)</span>';

    sliderContainer.appendChild(sliderHeader);
    sliderContainer.appendChild(sliderRow);
    sliderContainer.appendChild(sliderLabels);
    controlsBox.appendChild(sliderContainer);

    body.appendChild(controlsBox);
    card.appendChild(body);
    col.appendChild(card);

    // --- Attach Event Listeners ---

    // Outage Switch Toggle Event
    outageInput.addEventListener('change', async () => {
      await handleOutageChange(p.name, outageInput);
    });

    // Slider Drag / Change Events
    rangeInput.addEventListener('input', () => {
      const val = parseInt(rangeInput.value, 10);
      const valBadge = document.getElementById(`slider-val-badge-${p.name}`);
      if (valBadge) valBadge.textContent = `${val}%`;
      state.editingSliders.set(p.name, val);

      // Enable Apply only if value is different from currently saved provider rate and admin key is present
      const savedVal = Math.round((p.fail_rate || 0) * 100);
      applyBtn.disabled = !state.hasAdminKey || val === savedVal;
    });

    // Apply Button Click Event
    applyBtn.addEventListener('click', async () => {
      await handleApplyFailRate(p.name, rangeInput, applyBtn);
    });

    return col;
  }

  function updateProviderCard(cardCol, p) {
    const card = cardCol.querySelector('.provider-card');
    const stateInfo = getProviderStateInfo(p);

    // Update Card Border Class
    card.classList.remove('provider-state-healthy', 'provider-state-outage', 'provider-state-cooldown');
    card.classList.add(stateInfo.cardClass);

    // Update Status Badge
    const stateBadge = cardCol.querySelector(`#provider-status-${p.name}`);
    if (stateBadge) {
      stateBadge.className = `badge ${stateInfo.badgeClass} provider-status-badge d-flex align-items-center gap-1`;
      stateBadge.innerHTML = `<i class="${stateInfo.iconClass}"></i><span class="status-label">${stateInfo.label}</span>`;
    }

    // Update Consecutive Failures
    const failuresEl = cardCol.querySelector(`#provider-consecutive-${p.name}`);
    if (failuresEl) {
      failuresEl.textContent = `${p.consecutive_failures || 0} / 2`;
    }

    // Update Failure Pips
    const meterEl = cardCol.querySelector(`#circuit-meter-${p.name}`);
    if (meterEl) {
      const pips = meterEl.querySelectorAll('.circuit-pip');
      if (pips.length === 2) {
        pips[0].className = `circuit-pip ${p.consecutive_failures >= 1 ? 'pip-warn' : ''}`;
        pips[1].className = `circuit-pip ${p.consecutive_failures >= 2 ? 'pip-danger' : ''}`;
      }
    }

    // Update Circuit Status
    const circuitEl = cardCol.querySelector(`#provider-circuit-${p.name}`);
    const openUntilEl = cardCol.querySelector(`#provider-open-until-${p.name}`);
    if (circuitEl && openUntilEl) {
      circuitEl.textContent = stateInfo.status === 'cooldown' ? 'Cooling Down' : 'Closed (Healthy)';
      openUntilEl.textContent = p.open_until && p.open_until > (Date.now() / 1000)
        ? `Active until ${new Date(p.open_until * 1000).toLocaleTimeString()}`
        : 'Normal dispatch';
    }

    // Update Outage Switch
    const outageInput = cardCol.querySelector(`#outage-switch-${p.name}`);
    const outageBadge = cardCol.querySelector(`#outage-state-badge-${p.name}`);
    if (outageInput && outageBadge) {
      outageInput.checked = Boolean(p.outage);
      outageInput.disabled = !state.hasAdminKey;
      outageBadge.className = `badge ${p.outage ? 'bg-danger' : 'bg-secondary'} small`;
      outageBadge.textContent = p.outage ? 'Outage Active' : 'Normal';
    }

    // Update Slider (only if user is not actively adjusting it)
    const rangeInput = cardCol.querySelector(`#slider-${p.name}`);
    const badgeEl = cardCol.querySelector(`#slider-val-badge-${p.name}`);
    const applyBtn = cardCol.querySelector(`#apply-btn-${p.name}`);

    if (rangeInput && badgeEl && applyBtn) {
      rangeInput.disabled = !state.hasAdminKey;

      if (!state.editingSliders.has(p.name)) {
        const savedPercent = Math.round((p.fail_rate || 0) * 100);
        rangeInput.value = String(savedPercent);
        badgeEl.textContent = `${savedPercent}%`;
        applyBtn.disabled = true;
      }
    }
  }

  // --- Actions Handlers ---

  async function handleOutageChange(providerName, switchEl) {
    if (!state.hasAdminKey) return;

    const targetOutage = switchEl.checked;
    switchEl.disabled = true;

    try {
      await DakGhar.fetch(`/api/providers/${providerName}`, {
        method: 'PATCH',
        body: { outage: targetOutage }
      });

      DakGhar.showToast(
        `${providerName}: Simulated outage ${targetOutage ? 'activated' : 'deactivated'}.`,
        targetOutage ? 'warning' : 'success'
      );

      // Refresh to confirm updated backend circuit state
      await fetchDashboardData();

    } catch (err) {
      // Revert switch on failure
      switchEl.checked = !targetOutage;
      const errorDetail = (err && err.data && err.data.detail) || err.message || 'Failed to update outage setting';
      DakGhar.showToast(errorDetail, 'error');
    } finally {
      switchEl.disabled = !state.hasAdminKey;
    }
  }

  async function handleApplyFailRate(providerName, rangeInput, applyBtn) {
    if (!state.hasAdminKey) return;

    const percent = parseInt(rangeInput.value, 10);
    // Convert 0-50 percent to 0.0 - 0.5 float
    const failRate = parseFloat((percent / 100).toFixed(2));

    applyBtn.disabled = true;
    applyBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';

    try {
      await DakGhar.fetch(`/api/providers/${providerName}`, {
        method: 'PATCH',
        body: { fail_rate: failRate }
      });

      // Clear in-progress edit state
      state.editingSliders.delete(providerName);

      DakGhar.showToast(`${providerName}: Failure rate updated to ${percent}%.`, 'success');

      // Refresh data
      await fetchDashboardData();

    } catch (err) {
      const errorDetail = (err && err.data && err.data.detail) || err.message || 'Failed to update failure rate';
      DakGhar.showToast(errorDetail, 'error');
    } finally {
      applyBtn.textContent = 'Apply';
      applyBtn.disabled = true;
    }
  }

  // --- Worker Actions ---

  if (toggleWorkerBtn) {
    toggleWorkerBtn.addEventListener('click', async () => {
      if (!state.hasAdminKey || !state.worker) return;

      const targetPaused = !state.worker.paused;

      toggleWorkerBtn.disabled = true;
      if (toggleWorkerSpinner) toggleWorkerSpinner.classList.remove('d-none');
      if (toggleWorkerIcon) toggleWorkerIcon.classList.add('d-none');

      try {
        const res = await DakGhar.fetch('/api/worker', {
          method: 'PATCH',
          body: { paused: targetPaused }
        });

        state.worker.paused = res.paused;
        renderWorkerStatus(state.worker);
        updateExecutiveKpis(state.worker, state.providers);

        DakGhar.showToast(
          res.paused ? 'Background worker paused.' : 'Background worker resumed.',
          res.paused ? 'info' : 'success'
        );

        // Re-check health indicator in navbar as well
        DakGhar.checkHealth();

      } catch (err) {
        const errorDetail = (err && err.data && err.data.detail) || err.message || 'Failed to update worker state';
        DakGhar.showToast(errorDetail, 'error');
      } finally {
        if (toggleWorkerSpinner) toggleWorkerSpinner.classList.add('d-none');
        if (toggleWorkerIcon) toggleWorkerIcon.classList.remove('d-none');
        toggleWorkerBtn.disabled = !state.hasAdminKey;
      }
    });
  }

  if (runTickBtn) {
    runTickBtn.addEventListener('click', async () => {
      if (!state.hasAdminKey) return;

      runTickBtn.disabled = true;
      if (runTickSpinner) runTickSpinner.classList.remove('d-none');
      if (runTickIcon) runTickIcon.classList.add('d-none');
      if (runTickText) runTickText.textContent = 'Ticking...';

      try {
        const res = await DakGhar.fetch('/api/worker/tick', {
          method: 'POST'
        });

        const processedCount = res.processed !== undefined ? res.processed : 0;

        if (processedCount > 0) {
          DakGhar.showToast(`Worker tick executed: ${processedCount} message(s) dispatched.`, 'success');
        } else {
          DakGhar.showToast('Worker tick executed: 0 messages were due.', 'info');
        }

        // Re-fetch status immediately
        await fetchDashboardData();

      } catch (err) {
        const errorDetail = (err && err.data && err.data.detail) || err.message || 'Manual tick failed';
        DakGhar.showToast(errorDetail, 'error');
      } finally {
        if (runTickSpinner) runTickSpinner.classList.add('d-none');
        if (runTickIcon) runTickIcon.classList.remove('d-none');
        if (runTickText) runTickText.textContent = 'Run One Tick';
        runTickBtn.disabled = !state.hasAdminKey;
      }
    });
  }

  // --- Manual Refresh Button ---

  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      if (refreshIcon) refreshIcon.classList.add('spin-animation');

      try {
        await fetchDashboardData();
        DakGhar.showToast('Provider and worker status refreshed.', 'info');
      } catch (_) {
        // Toast already handled by apiFetch
      } finally {
        if (refreshIcon) refreshIcon.classList.remove('spin-animation');
        refreshBtn.disabled = false;
      }
    });
  }

  // --- Live Cooldown Countdown Timer ---
  // Ticks every 1s purely in DOM without sending API requests

  function startCooldownTimer() {
    if (state.cooldownTimer) clearInterval(state.cooldownTimer);

    state.cooldownTimer = setInterval(() => {
      const now = Date.now() / 1000;
      let anyCooldownEnded = false;

      state.providers.forEach(p => {
        if (!p.outage && p.open_until && p.open_until > now) {
          const remaining = Math.max(0, Math.ceil(p.open_until - now));
          const badgeEl = document.getElementById(`provider-status-${p.name}`);
          if (badgeEl) {
            const labelSpan = badgeEl.querySelector('.status-label');
            if (labelSpan) {
              labelSpan.textContent = `Cooling Down (${remaining}s)`;
            }
          }
        } else if (!p.outage && p.open_until && p.open_until <= now && p.state === 'cooldown') {
          // Cooldown just expired!
          anyCooldownEnded = true;
        }
      });

      // If a cooldown expired, refresh to get clean "healthy" state from backend
      if (anyCooldownEnded && document.visibilityState === 'visible') {
        fetchDashboardData();
      }
    }, 1000);
  }

  // --- Background Auto-Refresh ---

  function startAutoRefresh() {
    if (state.pollTimer) clearInterval(state.pollTimer);

    state.pollTimer = setInterval(() => {
      // Skip background polling if tab is not visible
      if (document.visibilityState !== 'visible') return;

      fetchDashboardData();
    }, POLL_INTERVAL_MS);
  }

  // --- Listen to Key Updates from Settings Modal ---

  window.addEventListener('dakghar:keys-updated', () => {
    checkRole();
    fetchDashboardData({ isInitial: true });
  });

  // Clean up timers on page unload
  window.addEventListener('beforeunload', () => {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.cooldownTimer) clearInterval(state.cooldownTimer);
  });

  // --- Initial Startup ---

  checkRole();
  fetchDashboardData({ isInitial: true });
  startCooldownTimer();
  startAutoRefresh();
});
