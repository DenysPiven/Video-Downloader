// Download manager tab: takes jobs queued by the popup and saves them.
// Default target is Downloads/video-downloader via Chrome's download manager.
// Optionally the user picks any folder; then files are written straight into it
// (File System Access API) and HLS streams are written to disk in order.

import { idbGet, idbSet } from "./store.js";
import { isMaster, parseMaster, parseMedia } from "./hls-parse.js";
import { formatSize } from "./util.js";

const DEFAULT_DIR = "video-downloader";
const MAX_PARALLEL_JOBS = 2;
const SEGMENT_CONCURRENCY = 6;
const SEGMENT_WINDOW = 24; // max segments buffered ahead of the writer
const RETRIES = 4;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let dir = null;          // FileSystemDirectoryHandle, or null for Downloads/video-downloader
let permitted = true;
let running = 0;
const jobs = [];         // { id, url, kind, name, site, state, el }

// ---------- Target folder ----------

async function loadFolder() {
  dir = (await idbGet("dir")) || null;
  permitted = !dir || (await dir.queryPermission({ mode: "readwrite" })) === "granted";
  renderFolder();
}

async function chooseFolder() {
  try {
    const handle = await window.showDirectoryPicker({ id: "video-downloader", mode: "readwrite", startIn: "downloads" });
    dir = handle;
    permitted = true;
    await idbSet("dir", handle);
    await chrome.storage.local.set({ folderName: handle.name });
    renderFolder();
    pump();
  } catch (e) {
    if (e.name !== "AbortError") showBanner(`Can't use that folder: ${e.message}`, "Choose another", chooseFolder);
  }
}

async function useDownloads() {
  dir = null;
  permitted = true;
  await idbSet("dir", null);
  await chrome.storage.local.remove("folderName");
  renderFolder();
  pump();
}

async function allowAccess() {
  permitted = (await dir.requestPermission({ mode: "readwrite" })) === "granted";
  renderFolder();
  pump();
}

function renderFolder() {
  $("folder").textContent = dir ? dir.name : `Downloads/${DEFAULT_DIR}`;
  $("reset").hidden = !dir;
  const waiting = jobs.some((j) => j.state === "queued");
  if (dir && !permitted && waiting) showBanner(`Allow access to “${dir.name}” to start.`, "Allow", allowAccess);
  else hideBanner();
}

function showBanner(text, action, handler) {
  $("banner-text").textContent = text;
  $("banner-btn").textContent = action;
  $("banner-btn").onclick = handler;
  $("banner").hidden = false;
}
function hideBanner() { $("banner").hidden = true; }

// ---------- Queue ----------

async function takeQueued() {
  const { queue = [] } = await chrome.storage.session.get("queue");
  if (!queue.length) return;
  await chrome.storage.session.set({ queue: [] });
  for (const item of queue) addJob(item);
  renderFolder();
  pump();
}

function addJob(item) {
  const el = document.createElement("li");
  el.innerHTML = `<div class="job-top"><span class="job-name"></span><span class="job-state">Queued</span></div><div class="job-site"></div><div class="bar"><i></i></div><div class="job-note"></div>`;
  el.querySelector(".job-name").textContent = item.name;
  el.querySelector(".job-name").title = item.url;
  el.querySelector(".job-site").textContent = item.site ? `from ${item.site}` : "";
  $("jobs").append(el);
  jobs.push({ ...item, state: "queued", el });
  renderSummary();
}

function setJob(job, { state, text, progress, note, cls }) {
  if (state) job.state = state;
  const s = job.el.querySelector(".job-state");
  if (text !== undefined) {
    s.textContent = text;
    s.className = `job-state ${cls || ""}`;
  }
  if (progress !== undefined) job.el.querySelector(".bar > i").style.width = `${Math.round(progress * 100)}%`;
  if (note !== undefined) {
    const n = job.el.querySelector(".job-note");
    n.replaceChildren();
    if (note) n.append(note);
  }
  renderSummary();
}

function renderSummary() {
  const done = jobs.filter((j) => j.state === "done" || j.state === "skipped").length;
  const failed = jobs.filter((j) => j.state === "failed").length;
  const active = jobs.filter((j) => j.state === "active").length;
  $("big").firstChild.textContent = String(done);
  $("big").querySelector("small").textContent = `/ ${jobs.length}`;
  $("empty").hidden = jobs.length > 0;
  const parts = [];
  if (active) parts.push(`${active} downloading`);
  if (failed) parts.push(`${failed} failed`);
  $("summary").textContent = jobs.length
    ? (parts.length ? parts.join(" · ") : done === jobs.length ? "All done." : "Waiting…")
    : "Nothing in the queue yet.";
  document.title = jobs.length && done < jobs.length ? `${done}/${jobs.length} · Video Downloader` : "Video Downloader";
}

function pump() {
  if (!permitted) return;
  while (running < MAX_PARALLEL_JOBS) {
    const job = jobs.find((j) => j.state === "queued");
    if (!job) break;
    running++;
    setJob(job, { state: "active", text: "Starting…" });
    runJob(job)
      .catch((e) => fail(job, e))
      .finally(() => { running--; pump(); });
  }
}

function fail(job, e) {
  const note = document.createElement("span");
  note.append(`${e.message} `);
  if (job.kind === "file" && dir) {
    const retry = Object.assign(document.createElement("button"), { className: "link", textContent: "Save to Downloads instead" });
    retry.onclick = () => {
      chrome.downloads.download({ url: job.url, filename: `${DEFAULT_DIR}/${job.name}`, conflictAction: "uniquify" });
      setJob(job, { note: `Sent to Chrome downloads (Downloads/${DEFAULT_DIR}).` });
    };
    note.append(retry);
  }
  setJob(job, { state: "failed", text: "Failed", cls: "err", note });
}

// ---------- Targets ----------

async function existsInFolder(name) {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return file.size > 0;
  } catch {
    return false;
  }
}

async function existsInDownloads(name) {
  const found = await chrome.downloads.search({
    filenameRegex: `[\\\\/]${escapeRe(DEFAULT_DIR)}[\\\\/]${escapeRe(name)}$`,
    state: "complete",
    exists: true,
  });
  return found.length > 0;
}

async function alreadySaved(job, name) {
  if (!$("skip").checked) return false;
  const found = dir ? await existsInFolder(name) : await existsInDownloads(name);
  if (found) setJob(job, { state: "skipped", text: "Already saved", progress: 1, cls: "ok" });
  return found;
}

async function freeName(name) {
  if (!(await existsInFolder(name))) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await existsInFolder(candidate))) return candidate;
  }
}

async function folderWritable(job, name) {
  const finalName = await freeName(name);
  if (finalName !== name) setJob(job, { note: `Saved as “${finalName}”.` });
  const handle = await dir.getFileHandle(finalName, { create: true });
  return handle.createWritable(); // Chrome writes to a temp file and swaps on close
}

// Waits for a Chrome download to finish, reporting progress on the job.
async function trackDownload(job, id) {
  for (;;) {
    const [d] = await chrome.downloads.search({ id });
    if (!d) throw new Error("The download was removed.");
    if (d.state === "complete") return d;
    if (d.state === "interrupted") throw new Error(`Download interrupted (${d.error}).`);
    const total = d.totalBytes > 0 ? d.totalBytes : 0;
    setJob(job, {
      text: total ? `${Math.floor((d.bytesReceived / total) * 100)}% · ${formatSize(d.bytesReceived)} of ${formatSize(total)}` : formatSize(d.bytesReceived),
      progress: total ? d.bytesReceived / total : 0,
    });
    await sleep(500);
  }
}

// ---------- Direct files ----------

async function runJob(job) {
  if (job.kind === "hls") return runHls(job);
  if (await alreadySaved(job, job.name)) return;

  if (!dir) {
    const id = await chrome.downloads.download({ url: job.url, filename: `${DEFAULT_DIR}/${job.name}`, conflictAction: "uniquify" });
    const d = await trackDownload(job, id);
    setJob(job, { state: "done", text: `Done · ${formatSize(d.fileSize || d.bytesReceived)}`, progress: 1, cls: "ok" });
    return;
  }

  const res = await fetch(job.url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}.`);
  const total = Number(res.headers.get("content-length")) || 0;
  const writable = await folderWritable(job, job.name);

  let loaded = 0;
  let last = 0;
  const counter = new TransformStream({
    transform(chunk, ctrl) {
      loaded += chunk.byteLength;
      const now = performance.now();
      if (now - last > 250) {
        last = now;
        setJob(job, {
          text: total ? `${Math.floor((loaded / total) * 100)}% · ${formatSize(loaded)} of ${formatSize(total)}` : formatSize(loaded),
          progress: total ? loaded / total : 0,
        });
      }
      ctrl.enqueue(chunk);
    },
  });
  await res.body.pipeThrough(counter).pipeTo(writable);
  setJob(job, { state: "done", text: `Done · ${formatSize(loaded)}`, progress: 1, cls: "ok" });
}

// ---------- HLS ----------

async function getText(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for playlist.`);
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
      if (attempt >= RETRIES) throw new Error(`Segment download failed (${e.message}).`);
      await sleep(700 * attempt);
    }
  }
}

// Where HLS bytes go: straight to a file in the chosen folder, or collected in
// memory and handed to Chrome's downloads at the end.
async function hlsSink(job, name, type) {
  if (dir) return folderWritable(job, name);
  const parts = [];
  return {
    write: async (chunk) => { parts.push(chunk); },
    abort: async () => { parts.length = 0; },
    close: async () => {
      const blobUrl = URL.createObjectURL(new Blob(parts, { type }));
      try {
        const id = await chrome.downloads.download({ url: blobUrl, filename: `${DEFAULT_DIR}/${name}`, conflictAction: "uniquify" });
        await trackDownload(job, id);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    },
  };
}

async function runHls(job) {
  let url = job.url;
  let text = await getText(url);
  if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("Not an HLS playlist.");
  const warnings = [];

  if (isMaster(text)) {
    const { variants, separateAudio } = parseMaster(text, url);
    if (!variants.length) throw new Error("The playlist has no streams.");
    const best = variants[0];
    if (best.audioGroup && separateAudio.has(best.audioGroup)) warnings.push("Audio is a separate track in this stream, so the file may have no sound.");
    url = best.url;
    text = await getText(url);
  }

  const { segments, init, encrypted, live } = parseMedia(text, url);
  if (encrypted) throw new Error(`The stream is encrypted (${encrypted}) and can't be saved.`);
  if (!segments.length) throw new Error("The playlist has no segments.");
  if (live) warnings.push("Live stream: only the part currently in the playlist is saved.");
  if (warnings.length) setJob(job, { note: warnings.join(" ") });

  const ext = init ? "mp4" : "ts";
  const name = `${job.name}.${ext}`;
  if (await alreadySaved(job, name)) return;
  const sink = await hlsSink(job, name, init ? "video/mp4" : "video/mp2t");

  let next = 0, written = 0, bytes = 0, error = null;
  const ready = new Map();

  try {
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
        setJob(job, {
          text: `${Math.floor((written / segments.length) * 100)}% · ${formatSize(bytes)}`,
          progress: written / segments.length,
        });
      }
    };

    await Promise.all([writer(), ...Array.from({ length: SEGMENT_CONCURRENCY }, fetcher)]);
    if (error) throw error;
    setJob(job, { text: "Saving…" });
    await sink.close();
  } catch (e) {
    await sink.abort().catch(() => {});
    throw e;
  }

  setJob(job, { state: "done", text: `Done · ${formatSize(bytes)}`, progress: 1, cls: "ok" });
  if (ext === "ts") {
    setJob(job, { note: `${warnings.join(" ")} .ts plays in VLC or IINA; convert with: ffmpeg -i video.ts -c copy video.mp4`.trim() });
  }
}

// ---------- Init ----------

$("choose").addEventListener("click", chooseFolder);
$("reset").addEventListener("click", useDownloads);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.queue?.newValue?.length) takeQueued();
});
window.addEventListener("beforeunload", (e) => {
  if (jobs.some((j) => j.state === "active")) e.preventDefault();
});

await loadFolder();
await takeQueued();
renderSummary();
