document.addEventListener('DOMContentLoaded', () => {
  const startDate = document.getElementById('start-date');
  const startTime = document.getElementById('start-time');
  const endDate = document.getElementById('end-date');
  const endTime = document.getElementById('end-time');
  const form = document.getElementById('range-form');
  const status = document.getElementById('status');
  const startButton = document.getElementById('start');

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
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const range = buildRange({ startDate, startTime, endDate, endTime });
    status.textContent = 'Requesting videos from the active Ring tab...';
    startButton.disabled = true;

    chrome.runtime.sendMessage({ type: 'start-download', payload: { range } }, (response) => {
      startButton.disabled = false;
      if (!response?.ok) {
        status.textContent = response?.error || 'Unable to start downloads.';
        return;
      }

      const batches = response.summary?.batches || [];
      if (!batches.length) {
        status.textContent = 'No downloads were queued.';
        return;
      }

      const lines = batches.map((batch) => `${batch.cameraName} batch ${batch.batchNumber} (${batch.count} videos)`);
      status.textContent = `Queued ${batches.length} batch(es):\n${lines.join('\n')}`;
    });
  });
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
