# Video Downloader

A Chrome extension that finds videos in your open tabs and downloads them. Everything is set up and controlled from the toolbar popup.

## Features

- **Any site, every tab.** Watches which video files (MP4, WebM, MOV, MKV) and HLS streams (`.m3u8`) each tab loads, and also picks up `<video>` elements. The popup lists videos from all open tabs, grouped by site, with the most likely video in each tab pre-selected. The toolbar badge shows how many videos a tab has.
- **Folder.** Files go to `Downloads/Video Downloader` by default. The popup shows the current folder; **Change** opens the settings page, where you can pick any folder on disk (for example `Movies/My Show`) with the system folder picker, or a folder inside Downloads. Files written to a picked folder go straight into it, HLS streams included. Files are named after the page title.
- **Quality choice.** The popup reads each file's resolution, duration and whether it has an audio track. Files of one video in different qualities are merged into one row with a quality selector, e.g. `1080p · 459 MB`, `720p · 219 MB`. Video-only tracks from split-stream players are marked `no audio` and never chosen by default.
- **Skip duplicates.** With **Skip files already downloaded** on (default, in settings), files already downloaded to the same path are skipped, so re-running a series only fetches what's missing.
- **Chunked players.** Players that load a file in pieces with the byte range in the URL (`?bytes=0-131071`) are detected as one whole file.
- **Progress in the popup.** Running and finished downloads are listed at the top of the popup, with the source site for each.
- **yt-dlp helper (optional).** For sites whose player can't be saved from the browser (separate video and audio streams, signed URLs), the popup asks a local yt-dlp about the current tab and offers its qualities, including audio only. One click downloads and merges the best streams into `.mp4`.
- **HLS.** Streams are downloaded segment by segment in the background and joined into one file: `.mp4` for fMP4 streams, `.ts` for classic ones.

Everything runs inside Chrome, so your site logins and any browser VPN keep working.

## Installation

1. Download `video-downloader-<version>.zip` from the [latest release](https://github.com/DenysPiven/Video-Downloader/releases/latest) and unzip it to a folder you'll keep (Chrome loads the extension from there).
2. Open `chrome://extensions` and turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the unzipped `video-downloader` folder.
4. Pin the extension icon to the toolbar.

To update, replace the folder's contents with a newer release and click the reload button on the extension's card. You can also `git clone` the repository and load that folder instead.

## yt-dlp helper (optional)

1. Install the tools: `brew install yt-dlp ffmpeg` (keep yt-dlp fresh with `brew upgrade yt-dlp`).
2. Copy the extension ID from `chrome://extensions`.
3. Run `./native-host/install.sh <extension-id>` and reload the extension.

The helper saves into the Downloads folder (a folder picked in settings only exposes a handle, not a path). It downloads what yt-dlp can access; respect each site's terms.

## Usage

1. Open the pages with videos (as many tabs as you like) and start playing each one so the player begins loading.
2. Click the extension icon, check the videos you want and pick the quality. To change where files go, click **Change**.
3. Click **Download**. Progress shows up in the popup and in Chrome's downloads.

If a page was open before the extension was installed, reload it.

## Limitations

- Does not download encrypted or DRM-protected streams and does not bypass protection.
- Players that stream video and audio as separate byte-range chunks (MSE/DASH) need the yt-dlp helper.
- If an HLS stream carries audio as a separate track, the saved file may have no sound.
- HLS streams are joined in memory before saving, so very long streams (several GB) may not fit.
- For a picked folder, Chrome may ask to allow access again after a restart; the popup shows an **Allow** button when that happens.
- `.ts` files play in VLC or IINA. To convert to `.mp4`: `ffmpeg -i video.ts -c copy video.mp4`.

Only download content you have access to and are allowed to save.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Detects videos in network requests; runs the download queue |
| `popup.html`, `popup.js` | Popup: found videos, quality, download progress |
| `options.html`, `options.js` | Settings page: folder picker, skip duplicates |
| `settings.js`, `store.js` | Shared settings and the saved folder handle |
| `offscreen.html`, `offscreen.js` | HLS joining and writing into a picked folder |
| `hls-parse.js` | HLS playlist parsing |
| `mp4-audio.js` | Detects whether an MP4 has an audio track from its header |
| `native-host/` | Optional yt-dlp helper (native messaging host and installer) |
| `util.js`, `style.css` | Helpers and styles |
| `icons/` | Logo and toolbar icons |
| `fonts/` | Space Grotesk (SIL Open Font License, see `fonts/OFL.txt`) |
