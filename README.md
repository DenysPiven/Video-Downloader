# Video Downloader

A Chrome extension that finds videos in your open tabs and saves them to a folder you choose.

## Features

- **Any site, every tab.** Watches which video files (MP4, WebM, MOV, MKV) and HLS streams (`.m3u8`) each tab loads, and also picks up `<video>` elements. The popup lists videos from all open tabs, grouped by site, with the most likely video in each tab pre-selected. The toolbar badge shows how many videos a tab has.
- **Name template.** File names come from a template with `{title}` (page title), `{n}` (last number in the title, handy for episodes) and `{site}`. For example `My Show - {n} episode` gives `My Show - 12 episode.mp4`.
- **Folder.** Files go to `Downloads/video-downloader` by default. You can pick any other folder (for example `Movies/My Show`) in the download tab; files are then written straight into it. Files that were already saved are skipped, so re-running a series only fetches what's missing.
- **HLS.** Downloads the stream segment by segment and joins it into one file: `.mp4` for fMP4 streams, `.ts` for classic ones. With a custom folder the stream is written to disk as it downloads, so memory use stays small.

Downloads run in a separate Video Downloader tab with progress for each file; keep it open until they finish. Everything runs inside Chrome, so your site logins and any browser VPN keep working.

## Installation

1. Get the repository (`git clone`, or **Code → Download ZIP** and unzip it).
2. Open `chrome://extensions` and turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the repository folder.
4. Pin the extension icon to the toolbar.

## Usage

1. Open the pages with videos (as many tabs as you like) and start playing each one so the player begins loading.
2. Click the extension icon, check the videos you want and adjust the name template if needed.
3. Click **Download**. To save somewhere other than `Downloads/video-downloader`, click **Choose folder** in the download tab; after a Chrome restart it may ask to allow access to that folder again.

If the page was open before the extension was installed, reload it.

## Limitations

- Does not download encrypted or DRM-protected streams and does not bypass protection.
- Players that stream video and audio as separate byte-range chunks (MSE/DASH) are not supported.
- If an HLS stream carries audio as a separate track, the saved file may have no sound.
- Some sites refuse direct requests from the extension. With a custom folder, such files can be sent to `Downloads/video-downloader` instead with one click.
- In the default Downloads mode, HLS streams are assembled in memory before saving, so very long streams (several GB) may not fit; pick a custom folder for those.
- `.ts` files play in VLC or IINA. To convert to `.mp4`: `ffmpeg -i video.ts -c copy video.mp4`.

Only download content you have access to and are allowed to save.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Detects videos in each tab's network requests |
| `popup.html`, `popup.js` | Extension popup: video list, folder, and the Download button |
| `manager.html`, `manager.js` | Download tab: folder picker, queue, writing files to disk |
| `hls-parse.js` | HLS playlist parsing |
| `store.js` | Remembers the chosen folder (IndexedDB) |
| `icons/` | Logo and toolbar icons |
| `fonts/` | Space Grotesk (SIL Open Font License, see `fonts/OFL.txt`) |
| `util.js`, `style.css` | Helpers and styles |
