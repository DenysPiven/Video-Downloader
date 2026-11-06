// Offscreen document: does the work that needs a page.
// - HLS for Downloads: joins segments into a Blob and hands its URL back to the
//   service worker, which saves it through chrome.downloads.
// - Any job for a folder the user picked: writes the file straight into that
//   folder (File System Access); HLS segments are written in order as they arrive.

import { isMaster, parseMaster, parseMedia } from "./hls-parse.js";
import { formatSize } from "./util.js";
import { folderAccess } from "./store.js";

const MAX_PARALLEL_JOBS = 2;
const SEGMENT_CONCURRENCY = 6;
const SEGMENT_WINDOW = 24; // max segments buffered ahead of the writer
const RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

// ---------- Job queue ----------

const queue = [];
let running = 0;

function enqueue(task) {
  queue.push(task);
  pump();
}

function pump() {
  while (running < MAX_PARALLEL_JOBS && queue.length) {
    const task = queue.shift();
    running++;
    task().finally(() => { running--; pump(); });
  }
}

// ---------- Network ----------

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
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (attempt >= RETRIES) throw new Error(`Segment failed (${e.message})`);
      await sleep(700 * attempt);
    }
  }
}

// ---------- HLS ----------

async function resolveStream(src) {
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
  const ext = init ? "mp4" : "ts";
  if (ext === "ts") notes.push(".ts plays in VLC or IINA.");
  return { segments, init, ext, notes };
}

// Fetches segments in parallel and writes them to `sink` strictly in order.
async function writeStream(id, { segments, init }, sink) {
  let next = 0, written = 0, bytes = 0, error = null, last = 0;
  const ready = new Map();
  if (init) await sink.write(await getBytes(init));

  const fetcher = async () => {
    while (!error && next < segments.length) {
      const i = next++;
      while (!error && i - written > SEGMENT_WINDOW) await sleep(40);
      try { ready.set(i, await getBytes(segments[i])); } catch (e) { error = e; }
    }
  };
  const writer = async () => {
    while (!error && written < segments.length) {
      if (!ready.has(written)) { await sleep(25); continue; }
      const chunk = ready.get(written);
      ready.delete(written);
      await sink.write(chunk);
      bytes += chunk.byteLength;
      written++;
      const now = performance.now();
      if (now - last > 400 || written === segments.length) {
        last = now;
        send({ type: "job-progress", id, progress: written / segments.length, text: `${Math.floor((written / segments.length) * 100)}% · ${formatSize(bytes)}` });
      }
    }
  };

  await Promise.all([writer(), ...Array.from({ length: SEGMENT_CONCURRENCY }, fetcher)]);
  if (error) throw error;
  return bytes;
}

async function hlsToDownloads(id, url) {
  const stream = await resolveStream(url);
  const parts = [];
  await writeStream(id, stream, { write: async (c) => { parts.push(c); } });
  const blob = new Blob(parts, { type: stream.init ? "video/mp4" : "video/mp2t" });
  send({ type: "hls-done", id, blobUrl: URL.createObjectURL(blob), ext: stream.ext, note: stream.notes.join(" ") });
}

// ---------- Chosen folder ----------

async function openFolder() {
  const { dir, permission } = await folderAccess();
  if (!dir) throw new Error("No folder chosen. Pick one in Settings.");
  if (permission !== "granted") throw Object.assign(new Error("Folder access needed. Allow it in Settings."), { needsAccess: true });
  return dir;
}

async function exists(dir, name) {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size > 0;
  } catch {
    return false;
  }
}

async function freeName(dir, name) {
  if (!(await exists(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(dir, candidate))) return candidate;
  }
}

async function createFile(dir, name) {
  const finalName = await freeName(dir, name);
  const handle = await dir.getFileHandle(finalName, { create: true });
  return { writable: await handle.createWritable(), finalName }; // Chrome swaps the temp file in on close
}

async function saveToFolder({ id, url, kind, fileName, skip }) {
  const dir = await openFolder();

  if (kind === "hls") {
    const stream = await resolveStream(url);
    const name = `${fileName}.${stream.ext}`;
    if (skip && (await exists(dir, name))) return send({ type: "job-skipped", id });
    const { writable, finalName } = await createFile(dir, name);
    try {
      const bytes = await writeStream(id, stream, writable);
      await writable.close();
      send({ type: "job-done", id, text: `Done · ${formatSize(bytes)}`, note: [finalName !== name ? `Saved as “${finalName}”` : "", ...stream.notes].filter(Boolean).join(" ") });
    } catch (e) {
      await writable.abort().catch(() => {});
      throw e;
    }
    return;
  }

  if (skip && (await exists(dir, fileName))) return send({ type: "job-skipped", id });
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const { writable, finalName } = await createFile(dir, fileName);

  let loaded = 0, last = 0;
  const counter = new TransformStream({
    transform(chunk, ctrl) {
      loaded += chunk.byteLength;
      const now = performance.now();
      if (now - last > 400) {
        last = now;
        send({
          type: "job-progress", id,
          progress: total ? loaded / total : 0,
          text: total ? `${Math.floor((loaded / total) * 100)}% · ${formatSize(loaded)} of ${formatSize(total)}` : formatSize(loaded),
        });
      }
      ctrl.enqueue(chunk);
    },
  });
  await res.body.pipeThrough(counter).pipeTo(writable); // aborts the file on error
  send({ type: "job-done", id, text: `Done · ${formatSize(loaded)}`, note: finalName !== fileName ? `Saved as “${finalName}”` : "" });
}

// ---------- Messages ----------

const fail = (id) => (e) => send({ type: "job-failed", id, error: e.message, needsAccess: Boolean(e.needsAccess) });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "hls") enqueue(() => hlsToDownloads(msg.id, msg.url).catch(fail(msg.id)));
  if (msg.type === "save") enqueue(() => saveToFolder(msg.job).catch(fail(msg.job.id)));
  if (msg.type === "revoke") setTimeout(() => URL.revokeObjectURL(msg.blobUrl), 5000);
});
