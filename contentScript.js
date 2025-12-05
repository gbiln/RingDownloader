const EVENT_ROW_SELECTORS = [
  '[data-testid="event-row"]',
  '[data-test-id="event-row"]',
  '.event-row',
  '.history-event'
];

const DASHBOARD_TILE_SELECTORS = [
  '[data-testid="camera-tile"], [data-test-id="camera-tile"]',
  '[data-testid="device-tile"], [data-test-id="device-tile"]',
  '[data-testid="dashboard-device-tile"], [data-test-id="dashboard-device-tile"]',
  'a[href*="/dashboard"] article',
  'section [role="grid"] [role="gridcell"]'
];

const EVENT_HISTORY_LINK_SELECTORS = [
  'a[data-testid="event-history"], a[data-test-id="event-history"]',
  'button[data-testid="event-history"], button[data-test-id="event-history"]',
  'a[href*="event-history" i]',
  '[aria-label*="Event History" i]'
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

  if (message?.type === 'list-dashboard-cameras') {
    sendResponse({ tiles: listDashboardCameras() });
    return true;
  }

  if (message?.type === 'open-dashboard-camera') {
    openDashboardCamera(message.index)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'return-to-dashboard') {
    returnToDashboard()
      .then((ok) => sendResponse({ ok }))
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

  const cameraFilters = findCameraFilters();
  const events = [];

  // If the page offers per-camera filters (as shown in the Ring dashboard flow), iterate each
  // camera so we can reliably collect downloads per device.
  if (cameraFilters.length) {
    for (const filter of cameraFilters) {
      await applyCameraFilter(filter);
      const rows = await waitForTimeline();
      collectRowsInto(rows, range, events, filter.name);
    }
    return { events };
  }

  const rows = await waitForTimeline();
  collectRowsInto(rows, range, events);
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
    const rows = findEventRows();
    if (rows.length) {
      resolve(rows);
      return;
    }

    const observer = new MutationObserver(() => {
      const next = findEventRows();
      if (next.length) {
        observer.disconnect();
        resolve(next);
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

function findCameraFilters() {
  const filters = [];

  // Direct select dropdowns (common on Ring event history)
  document.querySelectorAll('select').forEach((select) => {
    const shouldConsider = /camera|device/i.test(select.name || '') || /camera|device/i.test(select.id || '');
    if (!shouldConsider && select.options.length <= 1) return;
    Array.from(select.options).forEach((option) => {
      const name = option.textContent?.trim();
      if (!name || /all cameras/i.test(name)) return;
      filters.push({ element: select, value: option.value, name });
    });
  });

  // Button + listbox pattern (e.g., data-testid="camera-filter")
  const listButtons = document.querySelectorAll('[data-testid*="camera" i][aria-haspopup="listbox"], [aria-label*="All Cameras" i]');
  listButtons.forEach((button) => {
    const listbox = button.parentElement?.querySelector('[role="listbox"], ul');
    if (!listbox) return;
    listbox.querySelectorAll('[role="option"], li, button').forEach((item) => {
      const name = item.textContent?.trim();
      if (!name || /all cameras/i.test(name)) return;
      filters.push({ element: item, name, listTrigger: button });
    });
  });

  return filters;
}

async function applyCameraFilter(filter) {
  if (filter.element.tagName === 'SELECT') {
    filter.element.value = filter.value;
    filter.element.dispatchEvent(new Event('change', { bubbles: true }));
    filter.element.dispatchEvent(new Event('input', { bubbles: true }));
    await waitForRowsChange();
    return;
  }

  if (filter.listTrigger) {
    filter.listTrigger.click();
  }

  filter.element.click();
  await waitForRowsChange();
}

function waitForRowsChange(timeout = 10000) {
  const before = findEventRows().length;
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const after = findEventRows().length;
      if (after !== before && after > 0) {
        observer.disconnect();
        resolve();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve();
    }, timeout);
  });
}

function collectRowsInto(rows, range, target, forcedCameraName) {
  rows.forEach((row) => {
    const event = extractEvent(row);
    if (!event) return;
    if (isAlreadyDownloaded(row)) return;
    if (forcedCameraName) {
      event.cameraName = forcedCameraName;
    }
    if (isWithinRange(event.recordedAt, range)) {
      target.push(event);
    }
  });
  target.sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
}

function isAlreadyDownloaded(row) {
  const explicit = row.querySelector(
    '[data-testid*="downloaded" i], [data-test-id*="downloaded" i], .downloaded, [aria-label*="downloaded" i]'
  );
  if (explicit) return true;

  const titleIndicatesDownload = Array.from(row.querySelectorAll('title')).some((title) =>
    /download(ed)?/i.test(title.textContent || '')
  );
  if (titleIndicatesDownload) return true;

  const icon = row.querySelector('svg use[href*="download"], svg path[d*="download" i], [data-icon*="download" i]');
  return Boolean(icon);
}

function listDashboardCameras() {
  return findDashboardTiles().map((tile, index) => ({
    index,
    name: readCameraName(tile),
  }));
}

async function openDashboardCamera(index) {
  const tiles = findDashboardTiles();
  const target = tiles[index];

  if (!target) {
    throw new Error(`Could not find camera tile ${index + 1}.`);
  }

  target.scrollIntoView({ block: 'center' });
  target.click();

  const eventHistoryLink = await waitForEventHistoryLink();
  eventHistoryLink.click();
  await waitForTimeline();

  return { cameraName: readCameraName(target) };
}

async function returnToDashboard() {
  window.history.back();
  await waitForDashboardTiles();
  return true;
}

function findDashboardTiles() {
  const selector = DASHBOARD_TILE_SELECTORS.join(', ');
  const tiles = Array.from(document.querySelectorAll(selector));
  return tiles.filter((tile, index) => tiles.indexOf(tile) === index);
}

function readCameraName(tile) {
  return (
    tile.querySelector('[data-testid="camera-name"], [data-test-id="camera-name"], .camera-name, .device-name')?.textContent?.trim() ||
    tile.getAttribute('aria-label') ||
    tile.textContent?.trim() ||
    'Camera'
  );
}

function waitForDashboardTiles(timeout = 10000) {
  return new Promise((resolve, reject) => {
    const tiles = findDashboardTiles();
    if (tiles.length) {
      resolve(tiles);
      return;
    }

    const observer = new MutationObserver(() => {
      const next = findDashboardTiles();
      if (next.length) {
        observer.disconnect();
        resolve(next);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error('Timed out waiting for the Ring dashboard tiles to load.'));
    }, timeout);
  });
}

async function waitForEventHistoryLink(timeout = 10000) {
  const direct = findEventHistoryLink();
  if (direct) return direct;

  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const link = findEventHistoryLink();
      if (link) {
        observer.disconnect();
        resolve(link);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error('Timed out waiting for the Event History link.'));
    }, timeout);
  });
}

function findEventHistoryLink() {
  const selector = EVENT_HISTORY_LINK_SELECTORS.join(', ');
  const candidate = document.querySelector(selector);
  if (candidate) return candidate;

  return Array.from(document.querySelectorAll('a, button')).find((el) => /event history/i.test(el.textContent || ''));
}
