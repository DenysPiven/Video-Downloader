// Service worker.
// 1. Watches network responses in every tab and remembers the ones that look
//    like whole video files or HLS playlists (read by the popup per tab).
// 2. Runs downloads queued from the popup: plain files go straight to Chrome's
//    download manager; HLS streams are joined in an offscreen document first.
//    Job state lives in chrome.storage.session so the popup can show progress.

const SEGMENT_EXT = /\.(ts|m4s|m4a|m4v\?.*seg|aac|vtt|srt)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v|ogv)$/i;
const HLS_EXT = /\.m3u8$/i;
const MIN_FILE_BYTES = 300 * 1024; // smaller "videos" are previews/ads/segments
const MAX_PER_TAB = 60;

// Players often fetch one file in pieces by putting the byte range in the URL
// (e.g. ?bytes=0-131071). Removing that parameter gives the whole file.
function stripChunkParam(u) {
  let chunked = false;
  for (const k of [...u.searchParams.keys()]) {
    if (/^(range|bytes)$/i.test(k) && /^\d+-\d*$/.test(u.searchParams.get(k))) {
      u.searchParams.delete(k);
      chunked = true;
    }
  }
  return chunked;
}

const key = (tabId) => `tab_${tabId}`;
let chain = Promise.resolve(); // serialize storage writes
const serial = (fn) => (chain = chain.then(fn).catch((e) => console.error(e)));

// ---------- Detection ----------

function headerMap(headers = []) {
  const m = {};
  for (const h of headers) m[h.name.toLowerCase()] = h.value || "";
  return m;
}

function totalSize(h) {
  const cr = h["content-range"];
  if (cr) {
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) return Number(m[1]);
  }
  return h["content-length"] ? Number(h["content-length"]) : null;
}

function classify(details) {
  let u;
  try { u = new URL(details.url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;

  const h = headerMap(details.responseHeaders);
  const ct = (h["content-type"] || "").split(";")[0].trim().toLowerCase();
  const path = u.pathname;

  if (SEGMENT_EXT.test(path) || ct === "video/mp2t" || ct === "video/iso.segment") return null;
  if (/mpegurl/.test(ct) || HLS_EXT.test(path)) return { url: details.url, kind: "hls", ct, size: null };

  const binary = ct === "" || ct === "application/octet-stream" || ct === "binary/octet-stream";
  const looksVideo = ct.startsWith("video/") || (binary && (VIDEO_EXT.test(path) || details.type === "media"));
  if (!looksVideo) return null;

  // A chunk's own Content-Length is tiny; only the total from Content-Range counts.
  const chunked = stripChunkParam(u);
  const size = chunked && !h["content-range"] ? null : totalSize(h);
  if (size !== null && size < MIN_FILE_BYTES) return null;
  return { url: u.href, kind: "file", ct, size };
}

function record(tabId, entry) {
  serial(async () => {
    const k = key(tabId);
    const list = (await chrome.storage.session.get(k))[k] || [];
    const known = list.find((e) => e.url === entry.url);
    if (known) {
      if (!known.size && entry.size) {
        known.size = entry.size;
        await chrome.storage.session.set({ [k]: list });
      }
      return;
    }
    list.push({ ...entry, at: Date.now() });
    if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB);
    await chrome.storage.session.set({ [k]: list });
    chrome.action.setBadgeText({ tabId, text: String(list.length) }).catch(() => {});
  });
}

function clearTab(tabId) {
  serial(() => chrome.storage.session.remove(key(tabId)));
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
}

chrome.action.setBadgeBackgroundColor({ color: "#d4ff3f" });
chrome.action.setBadgeTextColor?.({ color: "#111214" });

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode >= 400) return;
    const entry = classify(details);
    if (entry) record(details.tabId, entry);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other", "object"] },
  ["responseHeaders"]
);

// A full page load starts a fresh list; same-page URL changes keep it.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) clearTab(tabId);
});
chrome.tabs.onRemoved.addListener(clearTab);

// ---------- Downloads ----------
// Job: { id, url, kind, name, site, path, saveAs, skip, state, text, progress, downloadId }
// state: queued | active | done | skipped | failed

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function updateJob(id, patch) {
  return serial(async () => {
    const { jobs = [] } = await chrome.storage.session.get("jobs");
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    Object.assign(job, patch);
    await chrome.storage.session.set({ jobs });
  });
}

async function getJob(id) {
  const { jobs = [] } = await chrome.storage.session.get("jobs");
  return jobs.find((j) => j.id === id);
}

// path is relative to Downloads, e.g. "Video Downloader/Show - 3 episode.mp4"
async function alreadyDownloaded(path) {
  const found = await chrome.downloads.search({
    filenameRegex: `[\\\\/]${escapeRe(path).replace(/\//g, "[\\\\/]")}$`,
    state: "complete",
    exists: true,
  });
  return found.length > 0;
}

async function startJob(job) {
  try {
    if (job.target === "folder") {
      await updateJob(job.id, { state: "active", text: "Starting…" });
      await ensureOffscreen();
      chrome.runtime.sendMessage({
        target: "offscreen", type: "save",
        job: { id: job.id, url: job.url, kind: job.kind, fileName: job.fileName, skip: job.skip },
      });
      return;
    }

    if (job.kind === "hls") {
      if (job.skip && ((await alreadyDownloaded(`${job.path}.mp4`)) || (await alreadyDownloaded(`${job.path}.ts`)))) {
        return updateJob(job.id, { state: "skipped", text: "Already downloaded", progress: 1 });
      }
      await updateJob(job.id, { state: "active", text: "Reading playlist…" });
      await ensureOffscreen();
      chrome.runtime.sendMessage({ target: "offscreen", type: "hls", id: job.id, url: job.url });
      return;
    }

    if (job.skip && (await alreadyDownloaded(job.path))) {
      return updateJob(job.id, { state: "skipped", text: "Already downloaded", progress: 1 });
    }
    const downloadId = await chrome.downloads.download({ url: job.url, filename: job.path, saveAs: job.saveAs, conflictAction: "uniquify" });
    await updateJob(job.id, { state: "active", text: "Downloading…", downloadId });
  } catch (e) {
    await updateJob(job.id, { state: "failed", text: e.message });
  }
}

async function enqueue(items) {
  const fresh = items.map((it) => ({ ...it, state: "queued", text: "Queued", progress: 0 }));
  await serial(async () => {
    const { jobs = [] } = await chrome.storage.session.get("jobs");
    await chrome.storage.session.set({ jobs: [...jobs, ...fresh] });
  });
  for (const job of fresh) await startJob(job);
}

// Learns the absolute Downloads folder from a finished download whose relative
// path we chose, so the popup can list existing subfolders from the history.
async function rememberDownloadsRoot(downloadId, job) {
  if (job.saveAs) return;
  const [d] = await chrome.downloads.search({ id: downloadId });
  if (!d?.filename) return;
  const file = d.filename.replace(/\\/g, "/");
  const rel = job.path.replace(/\\/g, "/");
  const relDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
  const dir = file.slice(0, file.lastIndexOf("/") + 1);
  if (relDir && !dir.endsWith(relDir)) return;
  const root = dir.slice(0, dir.length - relDir.length).replace(/\/$/, "");
  if (root) await chrome.storage.local.set({ downloadsRoot: root });
}

// File downloads report through chrome.downloads; HLS blobs too (with blobUrl).
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state && !delta.error) return;
  const { jobs = [] } = await chrome.storage.session.get("jobs");
  const job = jobs.find((j) => j.downloadId === delta.id);
  if (!job) return;
  if (delta.state?.current === "complete") {
    await updateJob(job.id, { state: "done", text: "Done", progress: 1 });
    rememberDownloadsRoot(delta.id, job);
  } else if (delta.state?.current === "interrupted" || delta.error) {
    const reason = delta.error?.current || "interrupted";
    await updateJob(job.id, { state: "failed", text: reason === "USER_CANCELED" ? "Canceled" : `Failed (${reason})` });
  }
  if (job.blobUrl && delta.state && delta.state.current !== "in_progress") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "revoke", blobUrl: job.blobUrl }).catch(() => {});
  }
});

// ---------- Offscreen document (HLS joining, writing to a chosen folder) ----------

let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Join HLS stream segments into one file and write downloads into the folder the user picked.",
  }).finally(() => { creating = null; });
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === "offscreen") return; // meant for the offscreen document

  if (msg.type === "enqueue") {
    enqueue(msg.items).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "clear-finished") {
    serial(async () => {
      const { jobs = [] } = await chrome.storage.session.get("jobs");
      await chrome.storage.session.set({ jobs: jobs.filter((j) => j.state === "queued" || j.state === "active") });
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "job-progress") {
    updateJob(msg.id, { text: msg.text, progress: msg.progress });
  }
  if (msg.type === "job-done") {
    updateJob(msg.id, { state: "done", text: msg.text || "Done", progress: 1, note: msg.note || "" });
  }
  if (msg.type === "job-skipped") {
    updateJob(msg.id, { state: "skipped", text: "Already in folder", progress: 1 });
  }
  if (msg.type === "job-failed") {
    updateJob(msg.id, { state: "failed", text: msg.error, needsAccess: Boolean(msg.needsAccess) });
  }
  if (msg.type === "hls-done") {
    (async () => {
      const job = await getJob(msg.id);
      if (!job) return;
      try {
        const downloadId = await chrome.downloads.download({
          url: msg.blobUrl, filename: `${job.path}.${msg.ext}`, saveAs: job.saveAs, conflictAction: "uniquify",
        });
        await updateJob(job.id, { text: "Saving…", downloadId, blobUrl: msg.blobUrl, note: msg.note || "" });
      } catch (e) {
        await updateJob(job.id, { state: "failed", text: e.message });
        chrome.runtime.sendMessage({ target: "offscreen", type: "revoke", blobUrl: msg.blobUrl }).catch(() => {});
      }
    })();
  }
});
