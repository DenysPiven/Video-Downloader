# Video Downloader

A Chrome extension that finds videos on a page and downloads them.

## Features

- **Any site.** Watches which video files (MP4, WebM, MOV, MKV) and HLS streams (`.m3u8`) the page loads, and also picks up `<video>` elements on the page. The toolbar badge shows how many videos were found.
- **HLS.** Downloads the stream segment by segment in a separate tab with a progress bar and joins the segments into one file: `.mp4` for fMP4 streams, `.ts` for classic ones.
- **Boosty.** For every open `boosty.to/<author>/posts/…` tab, fetches the videos through your Boosty session, with quality selection up to 4K.

Files are saved to **Downloads/Video Saver**. Everything runs inside Chrome, so your site logins and any browser VPN keep working.

## Installation

1. Get the repository (`git clone`, or **Code → Download ZIP** and unzip it).
2. Open `chrome://extensions` and turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the repository folder.
4. Pin the extension icon to the toolbar.

## Usage

1. Open a page with a video and start playing it so the player begins loading.
2. Click the extension icon and select the videos you want.
3. Click **Download**.

If the page was open before the extension was installed, reload it.

## Limitations

- Does not download encrypted or DRM-protected streams (Netflix, Disney+, Spotify, etc.) and does not bypass protection.
- YouTube is not supported: video and audio are delivered as separate chunks.
- If an HLS stream carries audio as a separate track, the saved file may have no sound.
- HLS streams are assembled in browser memory, so very long videos (several GB) may not fit.
- `.ts` files play in VLC or IINA. To convert to `.mp4`: `ffmpeg -i video.ts -c copy video.mp4`.

Only download content you have access to and are allowed to save.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Detects videos in each tab's network requests |
| `popup.html`, `popup.js` | Extension popup: video list and the Download button |
| `boosty.js` | Boosty mode |
| `hls.html`, `hls.js`, `hls-parse.js` | HLS stream download and assembly |
| `util.js`, `style.css` | Helpers and styles |
