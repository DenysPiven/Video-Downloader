// Offscreen document: downloads HLS streams segment by segment, joins them in
// order into one Blob and hands its URL back to the service worker, which saves
// it through chrome.downloads. Jobs run one at a time.

import { isMaster, parseMaster, parseMedia } from "./hls-parse.js";
import { formatSize } from "./util.js";

const SEGMENT_CONCURRENCY = 6;
const RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
let chain = Promise.resolve();

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
      if (attempt >= RETRIES) throw new Error(`Segment failed (${e.message})`);
      await sleep(700 * attempt);
    }
  }
}

async function runHls(id, src) {
  let url = src;
  let text = await getText(url);
  if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("Not an HLS playlist");
  const notes = [];

  if (isMaster(text)) {
    const { variants, separateAudio } = parseMaster(text, url);
    if (!variants.length) throw new Error("Playlist has no streams");
    const best = variants[0];
    if (best.audioGroup && separateAudio.has(best.audioGroup)) notes.push("Audio is a separate track; the file may be silent.");
    url = best.url;
    text = await getText(url);
  }

  const { segments, init, encrypted, live } = parseMedia(text, url);
  if (encrypted) throw new Error(`Encrypted stream (${encrypted})`);
  if (!segments.length) throw new Error("Playlist has no segments");
  if (live) notes.push("Live stream: only the current part is saved.");

  const parts = new Array(segments.length);
  let next = 0, done = 0, bytes = 0, last = 0;
  const initBuf = init ? await getBytes(init) : null;

  const worker = async () => {
    while (next < segments.length) {
      const i = next++;
      parts[i] = await getBytes(segments[i]);
      done++;
      bytes += parts[i].byteLength;
      const now = performance.now();
      if (now - last > 400 || done === segments.length) {
        last = now;
        send({ type: "hls-progress", id, progress: done / segments.length, text: `${Math.floor((done / segments.length) * 100)}% · ${formatSize(bytes)}` });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEGMENT_CONCURRENCY, segments.length) }, worker));

  const ext = init ? "mp4" : "ts";
  if (ext === "ts") notes.push(".ts plays in VLC or IINA.");
  const blob = new Blob(initBuf ? [initBuf, ...parts] : parts, { type: init ? "video/mp4" : "video/mp2t" });
  send({ type: "hls-done", id, blobUrl: URL.createObjectURL(blob), ext, note: notes.join(" ") });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "hls") {
    chain = chain.then(() => runHls(msg.id, msg.url).catch((e) => send({ type: "hls-failed", id: msg.id, error: e.message })));
  }
  if (msg.type === "revoke") {
    setTimeout(() => URL.revokeObjectURL(msg.blobUrl), 5000);
  }
});
