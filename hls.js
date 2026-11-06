// Downloads an unencrypted HLS stream segment by segment, joins the pieces in
// order and saves them as one file through Chrome's download manager.

import { isMaster, parseMaster, parseMedia } from "./hls-parse.js";
import { formatSize } from "./util.js";

const CONCURRENCY = 6;
const RETRIES = 4;

const params = new URLSearchParams(location.search);
const src = params.get("src");
const name = params.get("name") || "Video Saver/video";
const $ = (id) => document.getElementById(id);

const shortName = name.split("/").pop();
$("name").textContent = shortName;
$("src").textContent = src || "";
document.title = `⏳ ${shortName}`;

const info = (t, isError = false) => { $("info").textContent = t; $("info").className = isError ? "err" : ""; };
const warn = (t) => { $("warn").textContent += (($("warn").textContent ? " " : "") + t); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for playlist`);
  return r.text();
}

async function getBytes({ url, range }) {
  for (let attempt = 1; ; attempt++) {
    try {
      const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
      const r = await fetch(url, { credentials: "include", headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.arrayBuffer();
    } catch (e) {
      if (attempt >= RETRIES) throw new Error(`segment download failed (${e.message})`);
      await sleep(700 * attempt);
    }
  }
}

async function resolvePlaylist(url) {
  const text = await getText(url);
  if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("Not an HLS playlist.");
  if (!isMaster(text)) return { url, text };

  const { variants, separateAudio } = parseMaster(text, url);
  if (!variants.length) throw new Error("The playlist has no streams.");
  const best = variants[0];
  if (best.resolution) $("name").textContent = `${shortName} (${best.resolution})`;
  if (best.audioGroup && separateAudio.has(best.audioGroup)) {
    warn("Audio is a separate track in this stream, so the file may have no sound.");
  }
  return { url: best.url, text: await getText(best.url) };
}

async function run() {
  if (!src) throw new Error("No stream URL provided.");
  const playlist = await resolvePlaylist(src);
  const { segments, init, encrypted, live } = parseMedia(playlist.text, playlist.url);

  if (encrypted) throw new Error(`The stream is encrypted (${encrypted}). Encrypted streams are not supported.`);
  if (!segments.length) throw new Error("The playlist has no segments.");
  if (live) warn("This is a live stream: only the part currently in the playlist will be saved.");

  const parts = new Array(segments.length);
  let done = 0, bytes = 0, next = 0;
  $("bar").max = segments.length;

  const initBuf = init ? await getBytes(init) : null;

  async function worker() {
    while (next < segments.length) {
      const i = next++;
      parts[i] = await getBytes(segments[i]);
      done++;
      bytes += parts[i].byteLength;
      $("bar").value = done;
      info(`Segments: ${done} of ${segments.length} · ${formatSize(bytes)}`);
      document.title = `${Math.floor((done / segments.length) * 100)}% ${shortName}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segments.length) }, worker));

  // fMP4 streams (with an init segment) join into .mp4; classic TS streams into .ts.
  const ext = init ? "mp4" : "ts";
  const blob = new Blob(initBuf ? [initBuf, ...parts] : parts, { type: init ? "video/mp4" : "video/mp2t" });
  const blobUrl = URL.createObjectURL(blob);
  const id = await chrome.downloads.download({ url: blobUrl, filename: `${name}.${ext}`, conflictAction: "uniquify" });

  info(`Done: ${formatSize(blob.size)}. Saved to Downloads/${name.split("/").slice(0, -1).join("/")}.`);
  if (ext === "ts") warn("A .ts file plays in VLC or IINA. To convert to .mp4, run: ffmpeg -i video.ts -c copy video.mp4");
  document.title = `✅ ${shortName}`;

  // Keep the blob alive until Chrome has finished writing the file.
  chrome.downloads.onChanged.addListener((d) => {
    if (d.id === id && d.state && d.state.current !== "in_progress") URL.revokeObjectURL(blobUrl);
  });
}

run().catch((e) => {
  info(`Error: ${e.message}`, true);
  document.title = `❌ ${shortName}`;
});
