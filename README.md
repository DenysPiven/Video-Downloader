# Video Downloader

A Chrome extension that finds videos in your open tabs and downloads them. Everything is set up and controlled from the toolbar popup.

## Features

- **Any site, every tab.** Watches which video files (MP4, WebM, MOV, MKV) and HLS streams (`.m3u8`) each tab loads, and also picks up `<video>` elements. The popup lists videos from all open tabs, grouped by site, with the most likely video in each tab pre-selected. The toolbar badge shows how many videos a tab has.
- **Folder.** Files go to `Downloads/Video Downloader` by default; type any other subfolder of Downloads in the popup. Files are named after the page title.
- **Quality choice.** The popup reads each file's resolution and duration. Files of one video in different qualities are merged into one row with a quality selector (best first), e.g. `1080p · 459 MB`, `720p · 219 MB`.
- **Skip duplicates.** With **Skip files already downloaded** on (default), files already downloaded to the same path are skipped, so re-running a series only fetches what's missing.
- **Chunked players.** Players that load a file in pieces with the byte range in the URL (`?bytes=0-131071`) are detected as one whole file.
- **Progress in the popup.** Running and finished downloads are listed at the top of the popup, with the source site for each.
- **HLS.** Streams are downloaded segment by segment in the background and joined into one file: `.mp4` for fMP4 streams, `.ts` for classic ones.

Everything runs inside Chrome, so your site logins and any browser VPN keep working.

## Installation

1. Get the repository (`git clone`, or **Code → Download ZIP** and unzip it).
2. Open `chrome://extensions` and turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the repository folder.
4. Pin the extension icon to the toolbar.

## Usage

1. Open the pages with videos (as many tabs as you like) and start playing each one so the player begins loading.
2. Click the extension icon, check the videos you want, and change the folder if needed.
3. Click **Download**. Progress shows up in the popup and in Chrome's downloads.

If a page was open before the extension was installed, reload it.

## Limitations

- Does not download encrypted or DRM-protected streams and does not bypass protection.
- Players that stream video and audio as separate byte-range chunks (MSE/DASH) are not supported.
- If an HLS stream carries audio as a separate track, the saved file may have no sound.
- HLS streams are joined in memory before saving, so very long streams (several GB) may not fit.
- Files can only go inside the Downloads folder (a Chrome restriction).
- `.ts` files play in VLC or IINA. To convert to `.mp4`: `ffmpeg -i video.ts -c copy video.mp4`.

Only download content you have access to and are allowed to save.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Detects videos in network requests; runs the download queue |
| `popup.html`, `popup.js` | Popup: settings, found videos, download progress |
| `offscreen.html`, `offscreen.js` | Background HLS download and joining |
| `hls-parse.js` | HLS playlist parsing |
| `util.js`, `style.css` | Helpers and styles |
| `icons/` | Logo and toolbar icons |
| `fonts/` | Space Grotesk (SIL Open Font License, see `fonts/OFL.txt`) |
