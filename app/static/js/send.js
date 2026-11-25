/**
 * DakGhar (डाकघर) Notification Delivery Service - Send Screen (Screen 1)
 *
 * Responsibilities:
 * 1. Manages channel toggle (Email vs SMS) and category toggle (Transactional vs Marketing).
 * 2. Provides real-time regex validation for email and international SMS formats.
 *    - Clears stale feedback when the recipient field is empty.
 * 3. Calculates dynamic character counts and approximate multi-part SMS chunk indicators.
 * 4. Explicitly validates trimmed message body length and mandatory email subject before submission.
 * 5. Provides quick-fill presets for instant demo testing (valid and bounce addresses).
 * 6. Sends POST /api/messages with X-Api-Key and displays 201 Created toast feedback.
 */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // --- Regex Validation Constants (PRD Section 10) ---
  const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const PHONE_REGEX = /^\+[1-9][0-9]{7,14}$/;

  // --- DOM Elements ---
  const form = document.getElementById('sendMessageForm');
  const channelEmailRadio = document.getElementById('channelEmail');
  const channelSmsRadio = document.getElementById('channelSms');
  const catTransactionalRadio = document.getElementById('catTransactional');
  const catMarketingRadio = document.getElementById('catMarketing');

  const recipientInput = document.getElementById('recipientInput');
  const recipientLabel = document.getElementById('recipientLabel');
  const recipientIcon = document.getElementById('recipientIcon');
  const recipientFeedback = document.getElementById('recipientFeedback');
  const recipientHelp = document.getElementById('recipientHelp');

  const subjectGroup = document.getElementById('subjectGroup');
  const subjectInput = document.getElementById('subjectInput');
  const subjectCounter = document.getElementById('subjectCounter');

  const bodyInput = document.getElementById('bodyInput');
  const bodyCounter = document.getElementById('bodyCounter');
  const bodyHelp = document.getElementById('bodyHelp');

  const idempotencyKeyInput = document.getElementById('idempotencyKeyInput');

  const submitBtn = document.getElementById('submitBtn');
  const submitSpinner = document.getElementById('submitSpinner');
  const submitIcon = document.getElementById('submitIcon');
  const submitText = document.getElementById('submitText');
  const resetBtn = document.getElementById('resetBtn');

  // Quick fill presets
  const btnPresetValidEmail = document.getElementById('btnPresetValidEmail');
  const btnPresetBounceEmail = document.getElementById('btnPresetBounceEmail');
  const btnPresetValidSms = document.getElementById('btnPresetValidSms');
  const btnPresetBounceSms = document.getElementById('btnPresetBounceSms');

  // --- State Initialization ---
  const savedPrefs = DakGhar.getPrefs();
  let currentChannel = savedPrefs.lastChannel === 'sms' ? 'sms' : 'email';

  // --- UI Configuration by Channel ---

  function setChannel(channel) {
    currentChannel = channel;
    DakGhar.savePrefs({ lastChannel: channel });

    if (channel === 'email') {
      channelEmailRadio.checked = true;
      recipientLabel.textContent = 'Recipient (Email Address)';
      if (recipientIcon) {
        recipientIcon.replaceChildren();
        const icon = document.createElement('i');
        icon.className = 'bi bi-at';
        recipientIcon.appendChild(icon);
      }
      recipientInput.placeholder = 'name@domain.tld';
      recipientInput.maxLength = 254;
      recipientHelp.textContent = 'Must match email format (e.g., user@shop.example). Max 254 characters.';

      subjectGroup.style.display = 'block';
      subjectInput.required = true;

      bodyInput.maxLength = 2000;
      bodyHelp.textContent = 'Email body must be between 1 and 2,000 characters.';
    } else {
      channelSmsRadio.checked = true;
      recipientLabel.textContent = 'Recipient (Phone Number in E.164 format)';
      if (recipientIcon) {
        recipientIcon.replaceChildren();
        const icon = document.createElement('i');
        icon.className = 'bi bi-phone';
        recipientIcon.appendChild(icon);
      }
      recipientInput.placeholder = '+919812345678';
      recipientInput.maxLength = 16;
      recipientHelp.textContent = 'Must start with + and country code, e.g. +919812345678 (8 to 15 digits total).';

      // Email subject mandatory, SMS subject optional (hidden)
      subjectGroup.style.display = 'none';
      subjectInput.required = false;
      subjectInput.value = '';

      bodyInput.maxLength = 480;
      bodyHelp.textContent = 'SMS body must be between 1 and 480 characters (approx. 160 characters per SMS part).';
    }

    validateRecipient();
    updateCounters();
  }

  // Requirement 3: Clear stale feedback when empty, validate format when present
  function validateRecipient() {
    const val = recipientInput.value.trim();

    if (!val) {
      recipientInput.classList.remove('is-valid', 'is-invalid');
      recipientFeedback.textContent = '';
      return false;
    }

    if (currentChannel === 'email') {
      const isValid = val.length <= 254 && EMAIL_REGEX.test(val);
      if (isValid) {
        recipientInput.classList.remove('is-invalid');
        recipientInput.classList.add('is-valid');
        recipientFeedback.textContent = '';
        return true;
      } else {
        recipientInput.classList.remove('is-valid');
        recipientInput.classList.add('is-invalid');
        recipientFeedback.textContent = 'Please enter a valid email address (e.g. user@shop.example).';
        return false;
      }
    } else {
      const isValid = PHONE_REGEX.test(val);
      if (isValid) {
        recipientInput.classList.remove('is-invalid');
        recipientInput.classList.add('is-valid');
        recipientFeedback.textContent = '';
        return true;
      } else {
        recipientInput.classList.remove('is-valid');
        recipientInput.classList.add('is-invalid');
        recipientFeedback.textContent = 'Please enter a valid international phone number starting with + (e.g. +919812345678).';
        return false;
      }
    }
  }

  // Requirement 3: Clearly approximate SMS segment indicator
  function updateCounters() {
    // Subject Counter
    const subjectLen = subjectInput.value.length;
    subjectCounter.textContent = `${subjectLen} / 150`;

    // Body Counter
    const bodyLen = bodyInput.value.length;
    if (currentChannel === 'email') {
      bodyCounter.textContent = `${bodyLen.toLocaleString()} / 2,000`;
    } else {
      const parts = Math.ceil(bodyLen / 160) || 1;
      bodyCounter.textContent = `${bodyLen} / 480 (~${parts} of 3 SMS parts)`;
    }
  }

  // --- Preset Quick-Fills ---

  btnPresetValidEmail.addEventListener('click', () => {
    setChannel('email');
    catTransactionalRadio.checked = true;
    recipientInput.value = 'ritu@shop.example';
    subjectInput.value = 'Order KK-20931 confirmed';
    bodyInput.value = 'Hi Ritu, your order is confirmed.';
    validateRecipient();
    updateCounters();
  });

  btnPresetBounceEmail.addEventListener('click', () => {
    setChannel('email');
    catTransactionalRadio.checked = true;
    recipientInput.value = 'asha@bounce.example';
    subjectInput.value = 'Order KK-20932 confirmed';
    bodyInput.value = 'Bounce demo: no such mailbox.';
    validateRecipient();
    updateCounters();
  });

  btnPresetValidSms.addEventListener('click', () => {
    setChannel('sms');
    catTransactionalRadio.checked = true;
    recipientInput.value = '+919812345678';
    bodyInput.value = 'Your KiranaKart delivery OTP is 482913. Valid for 10 minutes.';
    validateRecipient();
    updateCounters();
  });

  btnPresetBounceSms.addEventListener('click', () => {
    setChannel('sms');
    catMarketingRadio.checked = true;
    recipientInput.value = '+919000000123';
    bodyInput.value = 'Fresh mangoes are back! Order today on DakGhar.';
    validateRecipient();
    updateCounters();
  });

  // --- Event Listeners ---

  channelEmailRadio.addEventListener('change', () => setChannel('email'));
  channelSmsRadio.addEventListener('change', () => setChannel('sms'));

  recipientInput.addEventListener('input', validateRecipient);
  subjectInput.addEventListener('input', updateCounters);
  bodyInput.addEventListener('input', updateCounters);

  resetBtn.addEventListener('click', () => {
    form.reset();
    setChannel('email');
    catTransactionalRadio.checked = true;
    recipientInput.classList.remove('is-valid', 'is-invalid');
    recipientFeedback.textContent = '';
    bodyInput.classList.remove('is-invalid');
    subjectInput.classList.remove('is-invalid');
    updateCounters();
  });

  // --- Form Submission ---

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const recipientValid = validateRecipient();
    const recipientVal = recipientInput.value.trim();
    const bodyVal = bodyInput.value.trim();
    const subjectVal = subjectInput.value.trim();
    const idempotencyVal = idempotencyKeyInput.value.trim();

    // 1. Validate Recipient
    if (!recipientValid || !recipientVal) {
      recipientInput.focus();
      DakGhar.showToast('Please provide a valid recipient before sending.', 'warning');
      return;
    }

    // 2. Validate Subject (Mandatory for Email, Optional for SMS)
    if (currentChannel === 'email') {
      if (!subjectVal) {
        subjectInput.classList.add('is-invalid');
        subjectInput.focus();
        DakGhar.showToast('Email subject is required (1 to 150 characters).', 'warning');
        return;
      }
      if (subjectVal.length > 150) {
        subjectInput.classList.add('is-invalid');
        subjectInput.focus();
        DakGhar.showToast('Email subject cannot exceed 150 characters.', 'warning');
        return;
      }
      subjectInput.classList.remove('is-invalid');
    }

    // 3. Explicitly Validate Trimmed Message Body Length
    if (!bodyVal) {
      bodyInput.classList.add('is-invalid');
      bodyInput.focus();
      DakGhar.showToast('Message body cannot be empty.', 'warning');
      return;
    }

    if (currentChannel === 'email' && bodyVal.length > 2000) {
      bodyInput.classList.add('is-invalid');
      bodyInput.focus();
      DakGhar.showToast('Email body must contain 1 to 2,000 characters.', 'warning');
      return;
    }

    if (currentChannel === 'sms' && bodyVal.length > 480) {
      bodyInput.classList.add('is-invalid');
      bodyInput.focus();
      DakGhar.showToast('SMS body must contain 1 to 480 characters.', 'warning');
      return;
    }
    bodyInput.classList.remove('is-invalid');

    // 4. Build Request Payload matching backend Pydantic model MessageCreate
    const payload = {
      channel: currentChannel,
      category: catTransactionalRadio.checked ? 'transactional' : 'marketing',
      to: recipientVal,
      body: bodyVal
    };

    if (currentChannel === 'email') {
      payload.subject = subjectVal;
    } else {
      payload.subject = null;
    }

    if (idempotencyVal) {
      payload.idempotency_key = idempotencyVal;
    }

    // 5. Loading UI State
    submitBtn.disabled = true;
    submitSpinner.classList.remove('d-none');
    submitIcon.classList.add('d-none');
    submitText.textContent = 'Enqueuing...';

    try {
      const response = await DakGhar.fetch('/api/messages', {
        method: 'POST',
        body: payload
      });

      // 6. Success Feedback Toast
      DakGhar.showToast(`Accepted as #${response.id}, pending`, 'success', {
        label: 'View Outbox',
        onClick: () => { window.location.href = 'outbox.html'; }
      });

      // Clear Form Fields
      recipientInput.value = '';
      subjectInput.value = '';
      bodyInput.value = '';
      idempotencyKeyInput.value = '';
      recipientInput.classList.remove('is-valid', 'is-invalid');
      recipientFeedback.textContent = '';
      updateCounters();

    } catch (err) {
      console.error('Error submitting notification:', err);

      // Display toast only for HTTP errors other than 401 and 403 (which api.js already handled),
      // and skip network failures (where err.status is undefined, also handled by api.js).
      if (err && err.status && err.status !== 401 && err.status !== 403) {
        const errorMsg = (err.data && err.data.detail) || err.message || 'Failed to submit notification.';
        DakGhar.showToast(errorMsg, 'error');
      }
    } finally {
      // Restore Button State
      submitBtn.disabled = false;
      submitSpinner.classList.add('d-none');
      submitIcon.classList.remove('d-none');
      submitText.textContent = 'Send Notification';
    }
  });

  // Initial setup
  setChannel(currentChannel);
});
