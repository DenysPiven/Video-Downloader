import { safeName, extFromUrl, formatSize } from "./util.js";
import { loadSettings, cleanFolder, folderLabel } from "./settings.js";
import { folderAccess } from "./store.js";

const $ = (id) => document.getElementById(id);

let items = []; // { checkbox, nameEl, kind, url, ext, site, title }
let settings = null;

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").className = isError ? "err" : "";
}

function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) e.append(c);
  return e;
}

// ---------- Folder ----------

async function renderFolder() {
  settings = await loadSettings();
  const { dir, permission } = await folderAccess();
  const custom = settings.folderMode === "custom" && dir;
  if (!custom) settings.folderMode = "downloads";
  $("folder-name").textContent = folderLabel(settings);
  $("folder-name").title = custom ? "A folder you picked" : "Inside your Downloads folder";
  $("access").hidden = !(custom && permission !== "granted");
}

const openSettings = () => chrome.runtime.openOptionsPage();

// ---------- Naming ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Page title without unread counters and a trailing " | Site name" part.
function cleanTitle(title, host) {
  let t = String(title || "").replace(/^\(\d+\)\s*/, "").trim();
  const root = host.split(".").slice(-2, -1)[0];
  if (root) t = t.replace(new RegExp(`\\s+[|–—-]\\s+[^|–—-]*${escapeRe(root)}[^|–—-]*$`, "i"), "").trim();
  return t || host;
}

function fileBase(it) {
  return safeName(it.title, "video");
}

// File names for all items; repeats inside one list get " 2", " 3"...
function finalNames() {
  const used = new Map();
  const out = new Map();
  for (const it of items) {
    let base = fileBase(it);
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    if (count > 1) base = `${base} ${count}`;
    out.set(it, it.kind === "hls" ? base : `${base}.${it.ext}`); // HLS extension is known after parsing
  }
  return out;
}

function refreshNames() {
  const names = finalNames();
  for (const it of items) {
    it.nameEl.textContent = it.kind === "hls" ? `${names.get(it)}.mp4` : names.get(it);
    it.nameEl.title = it.getUrl();
  }
}

function updateButton() {
  const n = items.filter((i) => i.checkbox.checked).length;
  $("download").disabled = n === 0;
  $("download").textContent = n ? `Download ${n} video${n === 1 ? "" : "s"}` : "Download";
}

// ---------- Finding videos ----------

const PAGE_SCAN_TIMEOUT_MS = 1500;

// Resolves to `fallback` if the promise takes longer than `ms`.
function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

async function videosInPage(tab) {
  // Sleeping or still-loading tabs may never answer a script injection.
  if (tab.discarded || tab.frozen || tab.status === "unloaded") return [];
  return withTimeout(scanPage(tab.id), PAGE_SCAN_TIMEOUT_MS, []);
}

async function scanPage(tabId) {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const out = new Set();
        const add = (u) => { try { const x = new URL(u, location.href); if (/^https?:$/.test(x.protocol)) out.add(x.href); } catch {} };
        document.querySelectorAll("video, video source, audio source").forEach((v) => {
          if (v.currentSrc) add(v.currentSrc);
          if (v.src) add(v.src);
        });
        document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]')
          .forEach((m) => m.content && add(m.content));
        return [...out];
      },
    });
    return frames.flatMap((f) => f.result || []);
  } catch {
    return []; // chrome:// pages, discarded tabs, the Web Store, etc.
  }
}

async function collect() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || ""));
  const stored = await chrome.storage.session.get(null);

  const groups = await Promise.all(tabs.map(async (tab) => {
    const entries = new Map((stored[`tab_${tab.id}`] || []).map((e) => [e.url, e]));
    for (const url of await videosInPage(tab)) {
      if (!entries.has(url)) entries.set(url, { url, kind: /\.m3u8(\?|#|$)/i.test(url) ? "hls" : "file", size: null });
    }
    return { tab, entries: [...entries.values()] };
  }));

  return groups
    .filter((g) => g.entries.length)
    .sort((a, b) => (b.tab.id === active?.id) - (a.tab.id === active?.id) || a.tab.windowId - b.tab.windowId || a.tab.index - b.tab.index);
}

// ---------- Qualities ----------

const PROBE_TIMEOUT_MS = 5000;

// Reads resolution and duration from the file header with a hidden <video>.
function probe(url) {
  return withTimeout(new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = (result) => { v.removeAttribute("src"); v.load(); resolve(result); };
    v.onloadedmetadata = () => done({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    v.onerror = () => done(null);
    v.src = url;
  }), PROBE_TIMEOUT_MS, null);
}

const knownDuration = (e) => Number.isFinite(e.meta?.duration) && e.meta.duration > 0;

// Files of one video in different qualities have the same duration: merge them
// into one video with several variants, best quality first.
function buildVideos(entries) {
  const videos = [];
  for (const e of entries) {
    if (e.kind === "file" && knownDuration(e)) {
      const same = videos.find((v) => v.kind === "file" && v.duration && Math.abs(v.duration - e.meta.duration) < 1.5);
      if (same) { same.variants.push(e); continue; }
      videos.push({ kind: "file", duration: e.meta.duration, variants: [e] });
    } else {
      videos.push({ kind: e.kind, duration: knownDuration(e) ? e.meta.duration : 0, variants: [e] });
    }
  }
  for (const v of videos) {
    v.variants.sort((a, b) => (b.meta?.height || 0) - (a.meta?.height || 0) || (b.size || 0) - (a.size || 0));
  }
  return videos;
}

// The video most likely to be "the" video of a tab: the longest file, else an
// HLS master playlist, else whatever was seen first.
function pickDefault(videos) {
  const files = videos.filter((v) => v.kind === "file");
  if (files.length) {
    return files.reduce((a, b) => (b.duration > a.duration || (b.duration === a.duration && (b.variants[0].size || 0) > (a.variants[0].size || 0)) ? b : a));
  }
  return videos.find((v) => /master|playlist|index/i.test(v.variants[0].url)) || videos[0];
}

function qualityLabel(e) {
  return [e.meta?.height ? `${e.meta.height}p` : null, e.size ? formatSize(e.size) : null].filter(Boolean).join(" · ") || "Unknown quality";
}

function formatDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// ---------- Rendering: found videos ----------

function renderGroup({ tab, entries }) {
  const videos = buildVideos(entries);
  const host = new URL(tab.url).hostname.replace(/^www\./, "");
  const title = cleanTitle(tab.title, host);
  const best = pickDefault(videos);
  const start = items.length;

  const toggle = el("button", { className: "link", textContent: "All", hidden: videos.length < 2 });
  toggle.addEventListener("click", () => {
    const mine = items.slice(start, start + videos.length);
    const allOn = mine.every((i) => i.checkbox.checked);
    for (const i of mine) i.checkbox.checked = !allOn;
    toggle.textContent = allOn ? "All" : "None";
    updateButton();
  });

  const letter = () => el("span", { className: "favicon letter", textContent: host[0]?.toUpperCase() || "?" });
  const icon = el("img", { className: "favicon", width: 16, height: 16, alt: "" });
  icon.addEventListener("error", () => icon.replaceWith(letter()));
  icon.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`);

  const box = el("section", {}, [el("div", { className: "site" }, [
    icon,
    el("div", { className: "site-text" }, [
      el("div", { className: "site-host", textContent: host }),
      el("div", { className: "site-title", textContent: title, title: tab.title || "" }),
    ]),
    toggle,
  ])]);

  videos.forEach((v) => {
    const checkbox = el("input", { type: "checkbox", checked: v === best });
    checkbox.addEventListener("change", updateButton);
    const nameEl = el("div", { className: "name" });
    const first = v.variants[0];
    const ext = extFromUrl(first.url, first.ct);
    let srcHost = "";
    try { srcHost = new URL(first.url).hostname.replace(/^www\./, ""); } catch {}

    let select = null;
    if (v.variants.length > 1) {
      select = el("select", { title: "Quality" });
      v.variants.forEach((e, i) => select.append(el("option", { value: String(i), textContent: qualityLabel(e) })));
    }
    const detail = [
      v.kind === "hls" ? "HLS stream" : ext.toUpperCase(),
      v.duration ? formatDuration(v.duration) : null,
      select ? null : (v.kind === "file" ? qualityLabel(first) : null),
      srcHost !== host ? srcHost : null,
    ].filter(Boolean).join(" · ");

    const text = el("div", { className: "row-text" }, [nameEl, el("div", { className: "detail", textContent: detail })]);
    text.addEventListener("click", () => { checkbox.checked = !checkbox.checked; updateButton(); });
    const row = el("div", { className: "row" }, [checkbox, text, select]);
    row.style.animationDelay = `${Math.min(items.length, 10) * 25}ms`;
    box.append(row);

    const getUrl = () => v.variants[select ? Number(select.value) : 0].url;
    items.push({ checkbox, nameEl, kind: v.kind, ext, site: host, title, getUrl });
  });

  $("list").append(box);
}

function renderEmpty() {
  $("list").append(el("div", { className: "empty" }, [
    el("img", { src: "icons/logo.svg", width: 48, height: 48, alt: "" }),
    el("strong", { textContent: "No videos found yet" }),
    el("span", { textContent: "Start playing a video in any tab, then scan again. Tabs opened before the extension was installed need a reload." }),
  ]));
}

// ---------- Rendering: downloads ----------

let jobs = [];
let liveBytes = new Map(); // downloadId -> { received, total }

function renderJobs() {
  $("jobs-box").hidden = jobs.length === 0;
  $("clear").hidden = !jobs.some((j) => j.state === "done" || j.state === "skipped" || j.state === "failed");
  $("jobs").replaceChildren(...[...jobs].reverse().map((j) => {
    let text = j.text || "";
    let progress = j.progress || 0;
    const live = j.downloadId != null && j.state === "active" ? liveBytes.get(j.downloadId) : null;
    if (live && j.kind === "file") {
      progress = live.total ? live.received / live.total : 0;
      text = live.total ? `${Math.floor(progress * 100)}% · ${formatSize(live.received)} of ${formatSize(live.total)}` : formatSize(live.received);
    }
    const cls = j.state === "failed" ? "err" : j.state === "done" || j.state === "skipped" ? "ok" : "";
    return el("div", { className: "job" }, [
      el("div", { className: "job-top" }, [
        el("span", { className: "job-name", textContent: j.name, title: j.path }),
        el("span", { className: `job-state ${cls}`, textContent: text }),
      ]),
      el("div", { className: "job-sub", textContent: [j.site && `from ${j.site}`, j.note].filter(Boolean).join(" · ") }),
      j.state === "active" ? el("div", { className: "bar" }, [el("i", { style: `width:${Math.round(progress * 100)}%` })]) : null,
    ]);
  }));
}

async function loadJobs() {
  ({ jobs = [] } = await chrome.storage.session.get("jobs"));
  renderJobs();
}

// Byte progress of running file downloads comes from Chrome's download manager.
async function pollBytes() {
  const ids = jobs.filter((j) => j.state === "active" && j.downloadId != null).map((j) => j.downloadId);
  if (ids.length) {
    const found = await chrome.downloads.search({ state: "in_progress" });
    liveBytes = new Map(found.filter((d) => ids.includes(d.id)).map((d) => [d.id, { received: d.bytesReceived, total: d.totalBytes > 0 ? d.totalBytes : 0 }]));
    renderJobs();
  }
  setTimeout(pollBytes, 800);
}

// ---------- Main ----------

async function scan() {
  items = [];
  $("list").replaceChildren();
  updateButton();
  setStatus("Looking for videos…");

  const groups = await collect();
  setStatus("Reading video info…");
  await Promise.all(groups.flatMap((g) => g.entries.filter((e) => e.kind === "file").map(async (e) => { e.meta = await probe(e.url); })));
  groups.forEach(renderGroup);
  refreshNames();

  if (!items.length) renderEmpty();
  setStatus(items.length ? `${items.length} video${items.length === 1 ? "" : "s"} in ${groups.length} tab${groups.length === 1 ? "" : "s"}` : "");
  updateButton();
}

async function downloadSelected() {
  const names = finalNames();
  const picked = items.filter((i) => i.checkbox.checked);
  if (!picked.length) return;
  await renderFolder();
  const toFolder = settings.folderMode === "custom";
  const folder = cleanFolder(settings.subfolder);
  const batch = picked.map((it) => {
    const name = names.get(it);
    return {
      id: crypto.randomUUID(),
      url: it.getUrl(),
      kind: it.kind,
      name: it.kind === "hls" ? `${name}.mp4` : name,
      target: toFolder ? "folder" : "downloads",
      fileName: name,                              // for a picked folder
      path: folder ? `${folder}/${name}` : name,   // for Downloads
      site: it.site,
      saveAs: false,
      skip: settings.skip,
    };
  });
  $("download").disabled = true;
  await chrome.runtime.sendMessage({ type: "enqueue", items: batch });
  for (const it of picked) it.checkbox.checked = false;
  updateButton();
}

$("change").addEventListener("click", openSettings);
$("allow").addEventListener("click", openSettings);
$("refresh").addEventListener("click", scan);
$("download").addEventListener("click", downloadSelected);
$("clear").addEventListener("click", () => chrome.runtime.sendMessage({ type: "clear-finished" }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.jobs) { jobs = changes.jobs.newValue || []; renderJobs(); }
  if (area === "local") renderFolder();
});

await renderFolder();
await loadJobs();
pollBytes();
scan().catch((e) => setStatus(`Error: ${e.message}`, true));
