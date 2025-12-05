const BATCH_LIMIT = 150;
const renameQueue = [];
const batchTracker = new Map();

chrome.runtime.onInstalled.addListener(() => {
  console.log('Ring Daily Downloader installed');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'start-download') {
    startDownloadFlow(message.payload)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((error) => {
        console.error('start-download failed', error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  if (message?.type === 'get-last-request') {
    chrome.storage.sync.get('lastRequest').then(({ lastRequest }) => {
      sendResponse({ lastRequest });
    });
    return true;
  }

  if (message?.type === 'mfa-status') {
    console.log('MFA status from content script', message.status);
  }

  if (message?.type === 'status-update') {
    chrome.runtime.sendMessage({ type: 'status-echo', text: message.text });
  }

  return false;
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const rename = renameQueue.shift();
  if (!rename) {
    return;
  }

  const safeCamera = rename.cameraName.replace(/[^a-z0-9_-]+/gi, '_');
  const filename = `${safeCamera}-${rename.dateLabel}-${rename.batchNumber}.zip`;
  suggest({ filename });
});

async function startDownloadFlow(payload) {
  const { range } = payload;
  await chrome.storage.sync.set({ lastRequest: payload });
  const tab = await requireRingTab();

  const eventsResponse = await chrome.tabs.sendMessage(tab.id, {
    type: 'collect-events',
    range,
  });

  if (eventsResponse?.requiresMfa) {
    throw new Error('Ring is prompting for MFA; complete MFA and retry.');
  }

  const events = eventsResponse?.events || [];
  if (!events.length) {
    throw new Error('No videos found for the requested time frame on this page.');
  }

  const grouped = groupByCamera(events);
  const dateLabel = formatDateLabel(range);
  const summary = [];

  for (const [cameraName, cameraEvents] of Object.entries(grouped)) {
    const batches = chunk(cameraEvents, BATCH_LIMIT);
    const existingCount = batchTracker.get(cameraName) || 0;

    for (let i = 0; i < batches.length; i += 1) {
      const batchNumber = existingCount + i + 1;
      const batch = batches[i];
      await triggerBatchDownload(tab.id, batch, { cameraName, dateLabel, batchNumber });
      summary.push({ cameraName, batchNumber, count: batch.length });
    }

    batchTracker.set(cameraName, existingCount + batches.length);
  }

  return { batches: summary };
}

async function requireRingTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/ring\.com/.test(tab.url)) {
    throw new Error('Open your Ring event history tab before starting a download.');
  }
  return tab;
}

async function triggerBatchDownload(tabId, batch, renameInfo) {
  renameQueue.push(renameInfo);

  const createdPromise = waitForDownloadCreated();
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'download-batch',
    batch,
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Ring did not start the batch download.');
  }

  await createdPromise;
}

function waitForDownloadCreated(timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onCreated.removeListener(listener);
      reject(new Error('Timed out waiting for Ring to start downloading.'));
    }, timeout);

    const listener = (item) => {
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(listener);
      resolve(item);
    };

    chrome.downloads.onCreated.addListener(listener);
  });
}

function groupByCamera(events) {
  return events.reduce((acc, event) => {
    const key = event.cameraName || 'UnknownCamera';
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(event);
    return acc;
  }, {});
}

function chunk(list, size) {
  const batches = [];
  for (let i = 0; i < list.length; i += size) {
    batches.push(list.slice(i, i + size));
  }
  return batches;
}

function formatDateLabel(range) {
  const start = range?.start ? new Date(range.start) : new Date();
  const end = range?.end ? new Date(range.end) : null;
  const format = (d) => d.toISOString().slice(0, 10);
  if (!end || format(start) === format(end)) {
    return format(start);
  }
  return `${format(start)}_to_${format(end)}`;
}
