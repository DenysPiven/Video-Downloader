import { safeName, extFromUrl, formatSize } from "./util.js";

const DEFAULTS = { subfolder: "video-downloader", nameTemplate: "{title}", skip: true, saveAs: false };
const $ = (id) => document.getElementById(id);

let items = []; // { checkbox, nameEl, kind, url, ext, site, title, n, index }
let settings = { ...DEFAULTS };

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").className = isError ? "err" : "";
}

function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) e.append(c);
  return e;
}

// ---------- Settings ----------

async function loadSettings() {
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $("folder").value = settings.subfolder;
  $("template").value = settings.nameTemplate === DEFAULTS.nameTemplate ? "" : settings.nameTemplate;
  $("skip").checked = settings.skip;
  $("saveAs").checked = settings.saveAs;
}

function saveSetting(key, value) {
  settings[key] = value;
  chrome.storage.local.set({ [key]: value });
}

// "Shows/My Show" -> "Shows/My Show"; strips unsafe parts and "..".
function cleanFolder(s) {
  return String(s || "")
    .split(/[\\/]+/)
    .map((p) => safeName(p, ""))
    .filter((p) => p && p !== "." && p !== "..")
    .join("/");
}

// ---------- Naming ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Page title without unread counters and a trailing " | Site name" part.
function cleanTitle(title, host) {
  let t = String(title || "").replace(/^\(\d+\)\s*/, "").trim();
  const root = host.split(".").slice(-2, -1)[0];
  if (root) t = t.replace(new RegExp(`\\s+[|–—-]\\s+[^|–—-]*${escapeRe(root)}[^|–—-]*$`, "i"), "").trim();
  return t || host;
}

// Episode-style number: the last number in the title ("Season 3 - 12" -> 12).
function lastNumber(title) {
  const all = String(title).match(/\d+/g);
  return all ? String(Number(all[all.length - 1])) : "";
}

function fileBase(it) {
  const name = (settings.nameTemplate || DEFAULTS.nameTemplate)
    .replaceAll("{title}", it.title)
    .replaceAll("{site}", it.site)
    .replaceAll("{n}", it.n || String(it.index + 1));
  return safeName(name, "video");
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
    it.nameEl.title = it.url;
  }
}

function updateButton() {
  const n = items.filter((i) => i.checkbox.checked).length;
  $("download").disabled = n === 0;
  $("download").textContent = n ? `Download ${n} video${n === 1 ? "" : "s"}` : "Download";
}

// ---------- Finding videos ----------

async function videosInPage(tabId) {
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

// The entry most likely to be "the video" of a tab: the biggest file, else an
// HLS master playlist, else whatever was seen first.
function pickDefault(entries) {
  const files = entries.filter((e) => e.kind === "file");
  if (files.length) return files.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a));
  return entries.find((e) => /master|playlist|index/i.test(e.url)) || entries[0];
}

async function collect() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || ""));
  const stored = await chrome.storage.session.get(null);

  const groups = await Promise.all(tabs.map(async (tab) => {
    const entries = new Map((stored[`tab_${tab.id}`] || []).map((e) => [e.url, e]));
    for (const url of await videosInPage(tab.id)) {
      if (!entries.has(url)) entries.set(url, { url, kind: /\.m3u8(\?|#|$)/i.test(url) ? "hls" : "file", size: null });
    }
    return { tab, entries: [...entries.values()] };
  }));

  return groups
    .filter((g) => g.entries.length)
    .sort((a, b) => (b.tab.id === active?.id) - (a.tab.id === active?.id) || a.tab.windowId - b.tab.windowId || a.tab.index - b.tab.index);
}

// ---------- Rendering: found videos ----------

function renderGroup({ tab, entries }) {
  const host = new URL(tab.url).hostname.replace(/^www\./, "");
  const title = cleanTitle(tab.title, host);
  const best = pickDefault(entries);
  const start = items.length;

  const toggle = el("button", { className: "link", textContent: "All", hidden: entries.length < 2 });
  toggle.addEventListener("click", () => {
    const mine = items.slice(start, start + entries.length);
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

  entries.forEach((e, i) => {
    const checkbox = el("input", { type: "checkbox", checked: e === best });
    checkbox.addEventListener("change", updateButton);
    const nameEl = el("div", { className: "name" });
    const ext = extFromUrl(e.url, e.ct);
    let srcHost = "";
    try { srcHost = new URL(e.url).hostname.replace(/^www\./, ""); } catch {}
    const detail = [e.kind === "hls" ? "HLS stream" : ext.toUpperCase(), e.size ? formatSize(e.size) : null, srcHost !== host ? srcHost : null]
      .filter(Boolean).join(" · ");

    const text = el("div", { className: "row-text" }, [nameEl, el("div", { className: "detail", textContent: detail })]);
    text.addEventListener("click", () => { checkbox.checked = !checkbox.checked; updateButton(); });
    const row = el("div", { className: "row" }, [checkbox, text]);
    row.style.animationDelay = `${Math.min(items.length, 10) * 25}ms`;
    box.append(row);

    items.push({ checkbox, nameEl, kind: e.kind, url: e.url, ext, site: host, title, n: lastNumber(title), index: i });
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
  const folder = cleanFolder(settings.subfolder);
  const batch = picked.map((it) => {
    const name = names.get(it);
    return {
      id: crypto.randomUUID(),
      url: it.url,
      kind: it.kind,
      name: it.kind === "hls" ? `${name}.mp4` : name,
      path: folder ? `${folder}/${name}` : name,
      site: it.site,
      saveAs: settings.saveAs,
      skip: settings.skip,
    };
  });
  $("download").disabled = true;
  await chrome.runtime.sendMessage({ type: "enqueue", items: batch });
  for (const it of picked) it.checkbox.checked = false;
  updateButton();
}

$("folder").addEventListener("input", (e) => saveSetting("subfolder", e.target.value));
$("folder").addEventListener("change", (e) => { e.target.value = cleanFolder(e.target.value); saveSetting("subfolder", e.target.value); });
$("template").addEventListener("input", (e) => { saveSetting("nameTemplate", e.target.value.trim() || DEFAULTS.nameTemplate); refreshNames(); });
$("skip").addEventListener("change", (e) => saveSetting("skip", e.target.checked));
$("saveAs").addEventListener("change", (e) => saveSetting("saveAs", e.target.checked));
$("refresh").addEventListener("click", scan);
$("download").addEventListener("click", downloadSelected);
$("clear").addEventListener("click", () => chrome.runtime.sendMessage({ type: "clear-finished" }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.jobs) { jobs = changes.jobs.newValue || []; renderJobs(); }
});

await loadSettings();
await loadJobs();
pollBytes();
scan().catch((e) => setStatus(`Error: ${e.message}`, true));
