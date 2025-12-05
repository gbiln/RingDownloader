const EVENT_ROW_SELECTORS = [
  '[data-testid="event-row"]',
  '[data-test-id="event-row"]',
  '.event-row',
  '.history-event'
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'collect-events') {
    collectEvents(message.range)
      .then((payload) => sendResponse(payload))
      .catch((error) => sendResponse({ error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'download-batch') {
    triggerBatchDownload(message.batch)
      .then((result) => sendResponse({ ok: result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});

async function collectEvents(range) {
  if (detectMfaPrompt()) {
    chrome.runtime.sendMessage({ type: 'mfa-status', status: 'mfa-required' });
    return { requiresMfa: true };
  }

  await waitForTimeline();
  const rows = findEventRows();
  const events = [];

  rows.forEach((row) => {
    const event = extractEvent(row);
    if (!event) return;
    if (isWithinRange(event.recordedAt, range)) {
      events.push(event);
    }
  });

  return { events };
}

async function triggerBatchDownload(batch) {
  const rowsById = indexRowsById();
  batch.forEach((event) => {
    const row = rowsById[event.id];
    const checkbox = row?.querySelector('input[type="checkbox"]');
    if (checkbox && !checkbox.checked) {
      checkbox.click();
    }
  });

  const downloadButton = document.querySelector('[data-testid="download"] button, button[data-testid="download"], button[aria-label*="Download"], [data-testid="download-button"]');
  if (downloadButton) {
    downloadButton.click();
    chrome.runtime.sendMessage({ type: 'status-update', text: `Requested download for ${batch.length} videos` });
    return true;
  }

  // fallback to anchor-based download
  const anchor = document.querySelector('a[href*="download"]');
  if (anchor) {
    anchor.click();
    return true;
  }

  throw new Error('Could not find the Ring download control on this page.');
}

function detectMfaPrompt() {
  const mfaInputs = document.querySelectorAll('input[type="tel"], input[name*="code"], input[id*="code"]');
  const otp = Array.from(mfaInputs).some((input) => input.autocomplete === 'one-time-code' || input.maxLength === 6);
  const label = Array.from(document.querySelectorAll('label')).some((el) => /verification code|authenticator/i.test(el.textContent || ''));
  return otp || label;
}

function waitForTimeline(timeout = 15000) {
  return new Promise((resolve, reject) => {
    const hasRows = () => findEventRows().length > 0;
    if (hasRows()) {
      resolve();
      return;
    }

    const observer = new MutationObserver(() => {
      if (hasRows()) {
        observer.disconnect();
        resolve();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error('Timed out waiting for the Ring event list to load.'));
    }, timeout);
  });
}

function findEventRows() {
  const selector = EVENT_ROW_SELECTORS.join(', ');
  return Array.from(document.querySelectorAll(selector));
}

function indexRowsById() {
  const index = {};
  findEventRows().forEach((row) => {
    const id = row.getAttribute('data-id') || row.getAttribute('data-event-id') || row.dataset?.id;
    if (id) {
      index[id] = row;
    }
  });
  return index;
}

function extractEvent(row) {
  const id = row.getAttribute('data-id') || row.getAttribute('data-event-id') || row.dataset?.id;
  const cameraName =
    row.querySelector('[data-testid="device-name"], .device-name, .camera-name, [data-test-id="device-name"]')?.textContent?.trim() || 'UnknownCamera';
  const dateText =
    row.querySelector('time')?.getAttribute('datetime') ||
    row.querySelector('time')?.textContent ||
    row.querySelector('[data-testid="event-time"], [data-test-id="event-time"]')?.textContent;
  const recordedAt = parseDate(dateText);

  if (!id || !recordedAt) {
    return null;
  }

  return {
    id,
    cameraName,
    recordedAt,
  };
}

function parseDate(text) {
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function isWithinRange(recordedAt, range) {
  if (!recordedAt) return false;
  const ts = new Date(recordedAt).getTime();
  const start = range?.start ? new Date(range.start).getTime() : null;
  const end = range?.end ? new Date(range.end).getTime() : null;
  if (start && ts < start) return false;
  if (end && ts > end) return false;
  return true;
}
