const EVENT_ROW_SELECTORS = [
  '[data-testid="event-row"]',
  '[data-test-id="event-row"]',
  '.event-row',
  '.history-event'
];

const BATCH_LIMIT = 150;

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

  await applyDateFilter(range);
  await loadAllEvents(range);

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
  await ensureManageSelection(batch);

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

async function ensureManageSelection(batch) {
  await openManageMenu();
  await clickSelectAll();

  const rowsById = indexRowsById();
  const selectedIds = new Set(batch.map((event) => event.id));

  const checkboxes = Array.from(document.querySelectorAll(`${EVENT_ROW_SELECTORS.join(', ')} input[type="checkbox"]`));
  checkboxes.forEach((checkbox) => {
    const row = checkbox.closest(EVENT_ROW_SELECTORS.join(', '));
    const id = row?.getAttribute('data-id') || row?.getAttribute('data-event-id') || row?.dataset?.id;
    if (!selectedIds.has(id) && checkbox.checked) {
      checkbox.click();
    }
  });

  let active = checkboxes.filter((box) => box.checked);
  if (active.length > BATCH_LIMIT) {
    active.slice(BATCH_LIMIT).forEach((box) => box.click());
    active = checkboxes.filter((box) => box.checked);
  }

  batch.forEach((event) => {
    const row = rowsById[event.id];
    const checkbox = row?.querySelector('input[type="checkbox"]');
    if (checkbox && !checkbox.checked) {
      checkbox.click();
    }
  });
}

async function openManageMenu() {
  const manageSelectors = [
    '[data-testid*="manage" i]',
    'button[aria-label*="Manage" i]',
    '[role="button"][aria-haspopup="menu"]',
  ];

  for (const selector of manageSelectors) {
    const button = document.querySelector(selector);
    if (button) {
      button.click();
      await waitForMenuOpen();
      return;
    }
  }

  const button = findButtonByText(/manage/i);
  if (button) {
    button.click();
    await waitForMenuOpen();
  }
}

async function clickSelectAll() {
  const menuItems = Array.from(
    document.querySelectorAll('button, [role="menuitem"], [role="option"], [data-testid*="select" i]')
  );
  const selectAll = menuItems.find((el) => /select all/i.test(el.textContent || ''));
  if (selectAll) {
    selectAll.click();
    await waitForRowsChange();
    return;
  }

  // If no menu option exists, try toggling any available "Select all" checkbox
  const checkbox = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((box) => {
    const label = box.closest('label');
    return /select all/i.test(label?.textContent || '') || /select all/i.test(box.getAttribute('aria-label') || '');
  });

  if (checkbox && !checkbox.checked) {
    checkbox.click();
    await waitForRowsChange();
  }
}

async function waitForMenuOpen(timeout = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    const observer = new MutationObserver(() => {
      const menu = document.querySelector('[role="menu"], [data-testid*="menu" i], [data-testid*="dropdown" i]');
      if (menu) {
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

async function applyDateFilter(range) {
  if (!range?.start && !range?.end) return;

  const trigger = findFilterTrigger();
  if (!trigger) return;

  trigger.click();
  await waitForFilterPanel();

  const formattedStart = range.start ? new Date(range.start).toISOString().slice(0, 10) : '';
  const formattedEnd = range.end ? new Date(range.end).toISOString().slice(0, 10) : '';

  const startInput = findDateInput('start');
  const endInput = findDateInput('end');

  if (startInput && formattedStart) {
    setInputValue(startInput, formattedStart);
  }
  if (endInput && formattedEnd) {
    setInputValue(endInput, formattedEnd);
  }

  const applyButton = findApplyButton();
  if (applyButton) {
    applyButton.click();
    await waitForRowsChange();
  }
}

function findFilterTrigger() {
  const selectors = [
    '[data-testid*="filter" i]',
    'button[aria-label*="Filter" i]',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }

  return findButtonByText(/filter/i);

}

function findDateInput(kind) {
  const keywords = kind === 'start' ? ['start', 'from', 'begin'] : ['end', 'to', 'until'];
  const inputs = Array.from(document.querySelectorAll('input[type="date"], input'));
  return inputs.find((input) =>
    keywords.some((word) => input.name?.toLowerCase().includes(word) || input.id?.toLowerCase().includes(word))
  );
}

function setInputValue(input, value) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function findApplyButton() {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  return buttons.find((button) => /apply|update|done|submit/i.test(button.textContent || ''));
}

function findButtonByText(regex) {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  return buttons.find((button) => regex.test(button.textContent || '') || regex.test(button.getAttribute('aria-label') || ''));
}

async function waitForFilterPanel(timeout = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    const observer = new MutationObserver(() => {
      const panel = document.querySelector('[data-testid*="filter" i], [role="dialog"], [aria-label*="Filter" i]');
      if (panel) {
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

async function loadAllEvents(range) {
  let stableIterations = 0;
  let previousCount = 0;
  const targetStart = range?.start ? new Date(range.start).getTime() : null;

  while (stableIterations < 3) {
    const before = findEventRows().length;
    await scrollTimelineToEnd();
    const clicked = await clickLoadMoreIfPresent();
    if (!clicked) {
      await waitForRowsChange(5000);
    }
    const after = findEventRows().length;

    if (after === before || after === previousCount) {
      stableIterations += 1;
    } else {
      stableIterations = 0;
    }

    previousCount = after;

    const oldest = findOldestTimestamp();
    if (targetStart && oldest && new Date(oldest).getTime() <= targetStart) {
      stableIterations += 1;
    }
  }
}

async function scrollTimelineToEnd() {
  const container = findScrollContainer();
  if (container) {
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  } else {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }
}

function findScrollContainer() {
  const rows = findEventRows();
  if (!rows.length) return null;
  const parent = rows[0].parentElement;
  if (parent && parent.scrollHeight > parent.clientHeight + 10) {
    return parent;
  }
  return null;
}

async function clickLoadMoreIfPresent() {
  const buttons = Array.from(document.querySelectorAll('button, a')); // allow anchors
  const loadMore = buttons.find((button) => /load more|next|older|show more/i.test(button.textContent || ''));
  if (loadMore) {
    loadMore.click();
    await waitForRowsChange();
    return true;
  }
  return false;
}

function findOldestTimestamp() {
  const dates = findEventRows()
    .map((row) => extractEvent(row)?.recordedAt)
    .filter(Boolean)
    .map((date) => new Date(date).getTime())
    .sort((a, b) => a - b);
  return dates[0] ? new Date(dates[0]).toISOString() : null;
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
