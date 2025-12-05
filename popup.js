document.addEventListener('DOMContentLoaded', () => {
  const startDate = document.getElementById('start-date');
  const startTime = document.getElementById('start-time');
  const endDate = document.getElementById('end-date');
  const endTime = document.getElementById('end-time');
  const form = document.getElementById('range-form');
  const status = document.getElementById('status');
  const startButton = document.getElementById('start');
  const pauseButton = document.getElementById('pause');
  const resumeButton = document.getElementById('resume');
  const stopButton = document.getElementById('stop');
  const counts = document.getElementById('counts');
  const cameraStatus = document.getElementById('camera-status');
  const log = document.getElementById('log');

  chrome.runtime.sendMessage({ type: 'get-last-request' }, (response) => {
    const range = response?.lastRequest?.range;
    if (range?.start) {
      const start = new Date(range.start);
      startDate.value = toDateValue(start);
      startTime.value = toTimeValue(start);
    }
    if (range?.end) {
      const end = new Date(range.end);
      endDate.value = toDateValue(end);
      endTime.value = toTimeValue(end);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'status-echo') {
      status.textContent = message.text;
    }

    if (message?.type === 'progress-update') {
      const total = message.state?.total || 0;
      const completed = message.state?.completed || 0;
      if (total) {
        counts.textContent = `Completed ${completed}/${total} videos`;
      }
      if (message.cameraName && message.batchNumber) {
        cameraStatus.textContent = `Camera: ${message.cameraName} (batch ${message.batchNumber})`;
      }
      appendLog(
        `Batch ${message.batchNumber || '?'} (${message.batchCount || '?'} items) finished for ${message.cameraName || 'camera'}`
      );
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const range = buildRange({ startDate, startTime, endDate, endTime });
    status.textContent = 'Requesting videos from the active Ring tab...';
    setBusyState();

    chrome.runtime.sendMessage({ type: 'start-download', payload: { range } }, (response) => {
      if (!response?.ok) {
        status.textContent = response?.error || 'Unable to start downloads.';
        setIdleState();
        return;
      }

      const batches = response.summary?.batches || [];
      if (!batches.length) {
        status.textContent = 'No downloads were queued.';
        setIdleState();
        return;
      }

      const lines = batches.map((batch) => `${batch.cameraName} batch ${batch.batchNumber} (${batch.count} videos)`);
      status.textContent = `Queued ${batches.length} batch(es):\n${lines.join('\n')}`;
      setRunningState();
    });
  });

  pauseButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'pause-download' }, (response) => {
      if (response?.ok) {
        status.textContent = 'Paused. Click resume to continue.';
        setPausedState();
      } else {
        status.textContent = response?.error || 'Unable to pause right now.';
      }
    });
  });

  resumeButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'resume-download' }, (response) => {
      if (response?.ok) {
        status.textContent = 'Resuming downloads...';
        setRunningState();
      } else {
        status.textContent = response?.error || 'Nothing to resume.';
      }
    });
  });

  stopButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'stop-download' }, (response) => {
      if (response?.ok) {
        status.textContent = 'Stopping downloads...';
      }
      setIdleState();
    });
  });

  chrome.runtime.sendMessage({ type: 'get-run-state' }, (response) => {
    const state = response?.state?.status;
    if (state === 'running') {
      setRunningState();
    } else if (state === 'paused') {
      setPausedState();
    } else {
      setIdleState();
    }
  });

  function appendLog(line) {
    const timestamp = new Date().toLocaleTimeString();
    log.textContent = `${timestamp} ${line}\n${log.textContent}`.slice(0, 2000);
  }

  function setIdleState() {
    startButton.disabled = false;
    pauseButton.disabled = true;
    resumeButton.disabled = true;
    stopButton.disabled = true;
  }

  function setBusyState() {
    startButton.disabled = true;
    pauseButton.disabled = true;
    resumeButton.disabled = true;
    stopButton.disabled = true;
  }

  function setRunningState() {
    startButton.disabled = true;
    pauseButton.disabled = false;
    resumeButton.disabled = true;
    stopButton.disabled = false;
  }

  function setPausedState() {
    startButton.disabled = true;
    pauseButton.disabled = true;
    resumeButton.disabled = false;
    stopButton.disabled = false;
  }
});

function buildRange({ startDate, startTime, endDate, endTime }) {
  const startDateValue = startDate.value;
  const endDateValue = endDate.value;

  const start = startDateValue ? combineDateTime(startDateValue, startTime.value) : null;
  const end = endDateValue ? combineDateTime(endDateValue, endTime.value || '23:59') : null;

  return {
    start,
    end: end || undefined,
  };
}

function combineDateTime(date, time) {
  const normalizedTime = time || '00:00';
  return `${date}T${normalizedTime}`;
}

function toDateValue(date) {
  return date.toISOString().slice(0, 10);
}

function toTimeValue(date) {
  return date.toTimeString().slice(0, 5);
}
