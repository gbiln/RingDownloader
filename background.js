const BATCH_LIMIT = 150;
const renameQueue = [];
const batchTracker = new Map();
const runState = {
  status: 'idle',
  jobId: 0,
  total: 0,
  completed: 0,
};

chrome.runtime.onInstalled.addListener(() => {
  console.log('Ring Daily Downloader installed');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'start-download') {
    if (runState.status === 'running' || runState.status === 'paused') {
      sendResponse({ ok: false, error: 'A download is already in progress. Stop or resume it first.' });
      return true;
    }

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

  if (message?.type === 'stop-download') {
    runState.status = 'stopped';
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'pause-download') {
    if (runState.status === 'running') {
      runState.status = 'paused';
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'No active download to pause.' });
    }
    return true;
  }

  if (message?.type === 'resume-download') {
    if (runState.status === 'paused') {
      runState.status = 'running';
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'Nothing is paused.' });
    }
    return true;
  }

  if (message?.type === 'get-run-state') {
    sendResponse({ state: { ...runState } });
    return true;
  }

  return false;
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const rename = renameQueue.shift();
  if (!rename) {
    return;
  }

  const safeCamera = rename.cameraName.replace(/[^a-z0-9_-]+/gi, '_');
  const filename = `${safeCamera}_${rename.startLabel}_to_${rename.endLabel}_Batch${rename.batchNumber}.zip`;
  suggest({ filename });
});

async function startDownloadFlow(payload) {
  const { range } = payload;
  runState.jobId += 1;
  const jobId = runState.jobId;
  runState.status = 'running';
  runState.total = 0;
  runState.completed = 0;

  await chrome.storage.sync.set({ lastRequest: payload });
  const tab = await requireRingTab();
  await focusRingTab(tab.id);

  const { startLabel, endLabel } = formatDateLabel(range);
  const summary = [];

  try {
    const dashboardResult = await attemptDashboardFlow(tab, range, { startLabel, endLabel }, summary, jobId);
    if (dashboardResult) {
      runState.status = 'idle';
      return dashboardResult;
    }

    const eventsResponse = await chrome.tabs.sendMessage(tab.id, {
      type: 'collect-events',
      range,
    });

    if (eventsResponse?.requiresMfa) {
      throw new Error('Ring is prompting for MFA; complete MFA and retry.');
    }

    const events = eventsResponse?.events || [];
    runState.total = events.length;
    if (!events.length) {
      runState.status = 'idle';
      throw new Error('No videos found for the requested time frame on this page.');
    }

    const grouped = groupByCamera(events);

    for (const [cameraName, cameraEvents] of Object.entries(grouped)) {
      await downloadCameraBatches(tab.id, cameraName, cameraEvents, { startLabel, endLabel }, summary, jobId);
    }

    runState.status = 'idle';
    return { batches: summary };
  } finally {
    if (runState.jobId === jobId && runState.status !== 'paused') {
      runState.status = 'idle';
    }
  }
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
  const end = range?.end ? new Date(range.end) : start;
  const format = (d) => d.toISOString().slice(0, 10);
  return { startLabel: format(start), endLabel: format(end) };
}

function sendProgress(data) {
  chrome.runtime.sendMessage({
    type: 'progress-update',
    state: { ...runState },
    ...data,
  });
}

async function ensureNotStopped(jobId) {
  if (runState.jobId !== jobId) return;
  if (runState.status === 'stopped') {
    runState.status = 'idle';
    throw new Error('Downloads were stopped.');
  }
}

async function waitIfPaused(jobId) {
  if (runState.jobId !== jobId) return;
  if (runState.status !== 'paused') return;

  await new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (runState.jobId !== jobId) {
        clearInterval(interval);
        reject(new Error('Download session changed.'));
        return;
      }
      if (runState.status === 'stopped') {
        clearInterval(interval);
        runState.status = 'idle';
        reject(new Error('Downloads were stopped.'));
      }
      if (runState.status === 'running') {
        clearInterval(interval);
        resolve();
      }
    }, 500);
  });
}

async function attemptDashboardFlow(tab, range, labels, summary, jobId) {
  const dashboard = await getDashboardTiles(tab.id);
  if (!dashboard?.tiles?.length) {
    return null;
  }

  let totalEvents = 0;

  for (let i = 0; i < dashboard.tiles.length; i += 1) {
    await ensureNotStopped(jobId);
    await waitIfPaused(jobId);
    await focusRingTab(tab.id);

    const openResponse = await chrome.tabs.sendMessage(tab.id, {
      type: 'open-dashboard-camera',
      index: i,
    });

    const cameraName = openResponse?.cameraName || dashboard.tiles[i]?.name || `Camera ${i + 1}`;

    const eventsResponse = await chrome.tabs.sendMessage(tab.id, {
      type: 'collect-events',
      range,
    });

    if (eventsResponse?.requiresMfa) {
      throw new Error('Ring is prompting for MFA; complete MFA and retry.');
    }

    const cameraEvents = (eventsResponse?.events || []).map((event) => ({
      ...event,
      cameraName: event.cameraName || cameraName,
    }));

    runState.total += cameraEvents.length;
    totalEvents += cameraEvents.length;

    await downloadCameraBatches(tab.id, cameraName, cameraEvents, labels, summary, jobId);

    await ensureNotStopped(jobId);

    const backResponse = await chrome.tabs.sendMessage(tab.id, {
      type: 'return-to-dashboard',
    });

    if (!backResponse?.ok) {
      throw new Error(backResponse?.error || 'Could not return to the Ring dashboard.');
    }
  }

  if (!totalEvents) {
    throw new Error('No videos found for the requested time frame on the Ring dashboard.');
  }

  return { batches: summary };
}

async function getDashboardTiles(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'list-dashboard-cameras' });
  } catch (error) {
    return null;
  }
}

async function focusRingTab(tabId) {
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  if (tab?.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

async function downloadCameraBatches(tabId, cameraName, cameraEvents, labels, summary, jobId) {
  await ensureNotStopped(jobId);
  const batches = chunk(cameraEvents, BATCH_LIMIT);
  const existingCount = batchTracker.get(cameraName) || 0;

  for (let i = 0; i < batches.length; i += 1) {
    const batchNumber = existingCount + i + 1;
    const batch = batches[i];
    await ensureNotStopped(jobId);
    await waitIfPaused(jobId);

    await triggerBatchDownload(tabId, batch, {
      cameraName,
      startLabel: labels.startLabel,
      endLabel: labels.endLabel,
      batchNumber,
    });
    summary.push({ cameraName, batchNumber, count: batch.length });
    runState.completed += batch.length;
    sendProgress({
      cameraName,
      batchNumber,
      batchCount: batch.length,
      status: 'completed-batch',
    });
  }

  batchTracker.set(cameraName, existingCount + batches.length);
}
