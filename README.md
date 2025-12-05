# Ring Daily Downloader

A Chrome extension that automates bulk downloads from Ring.com by day or time range, respecting Ring's 150-item batch limit and renaming the resulting ZIP files using `{CameraName}_{StartDate}_to_{EndDate}_Batch{N}`.

## Features

- Queue downloads across **all cameras** for a specific day or custom start/end time window.
- Enforces Ring's **150 video per download** limit by chunking events into batches.
- Detects when Ring is presenting an **MFA prompt** and waits for you to finish login.
- Renames ZIP files using `{CameraName}_{StartDate}_to_{EndDate}_Batch{N}` so you can distinguish multiple downloads per camera.
- Remembers the last date/time range you used.
- Skips events already marked as downloaded in the Ring UI so you can safely resume runs.
- Provides **Start / Pause / Resume / Stop** controls plus live progress per batch.

## Installing / loading the extension in Chrome

Chrome (and other Chromium browsers) can load the source directly; no build step is required.

1. **Download the code**
   - Option A: `git clone https://github.com/…/RingDownloader.git` and open the cloned folder.
   - Option B: Click **Code → Download ZIP** on GitHub, unzip it, and open the extracted folder.
2. **Open the Extensions page**
   - Visit `chrome://extensions/` in Chrome/Edge/Brave and toggle **Developer mode** on (top-right).
3. **Load the folder**
   - Click **Load unpacked**, then select the folder that contains `manifest.json` (the repo root).
   - The extension should appear in your list; pin it to the toolbar if desired.
4. **Updates**
   - If you pull new changes, return to `chrome://extensions/` and click **Reload** on the extension card.

## Using the downloader

1. Sign in to Ring.com in a tab. From the dashboard, click each camera tile's **⋯ / Event History** entry so the **Event History** page is visible (as in the screenshots), or use the **History** tab to reach the shared videos list.
2. If Ring prompts for MFA, complete it before starting a download. The extension will report when MFA is detected.
3. Open the extension popup:
   - Pick a start date (and optional time).
   - Optionally pick an end date/time. Leave blank to download a single day.
4. Click **Start**. The extension will:
   - Cycle through the Event History camera filter so every camera listed in the dashboard is processed.
   - Collect videos in the visible history that fall within the range for each camera.
   - Group them by camera, chunk each list into batches of 150, and trigger Ring's download control per batch.
   - Rename each ZIP as `{CameraName}_{StartDate}_to_{EndDate}_Batch{N}.zip` as Chrome receives it.
5. Watch the popup status text for progress updates. Use **Pause** or **Stop** if you need to halt the workflow; **Resume** picks up where the current page left off.

> Tip: Keep the Ring tab active while downloads are queued so the content script can interact with the page's checkboxes and download controls.

## Notes and limitations

- The extension uses DOM scraping to find event rows, camera names, and download controls. If Ring updates their UI, you may need to adjust selectors in `contentScript.js`.
- Downloads start from the **active Ring tab** only. Make sure the tab is showing the correct day or time window before you start.
- Batches are processed sequentially so filenames stay aligned with each ZIP Ring produces.
- If no videos are found in the requested window, the popup will report that nothing was queued.
- Bulk downloads rely on Ring's built-in multi-select download button. Ensure the page shows checkboxes next to events and that the Download action is visible.
