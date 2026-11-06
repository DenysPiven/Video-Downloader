// Watches network responses in every tab and remembers the ones that look like
// whole video files or HLS playlists. The popup reads this list per tab.

const SEGMENT_EXT = /\.(ts|m4s|m4a|m4v\?.*seg|aac|vtt|srt)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v|ogv)$/i;
const HLS_EXT = /\.m3u8$/i;
const MIN_FILE_BYTES = 300 * 1024; // smaller "videos" are previews/ads/segments
const MAX_PER_TAB = 60;

// Sites whose streams are split into many signed range requests and can't be
// saved as one file this way.
const SKIP_HOSTS = /(^|\.)googlevideo\.com$/i;

const key = (tabId) => `tab_${tabId}`;
let queue = Promise.resolve(); // serialize storage writes

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
  if (!/^https?:$/.test(u.protocol) || SKIP_HOSTS.test(u.hostname)) return null;

  const h = headerMap(details.responseHeaders);
  const ct = (h["content-type"] || "").split(";")[0].trim().toLowerCase();
  const path = u.pathname;

  if (SEGMENT_EXT.test(path) || ct === "video/mp2t" || ct === "video/iso.segment") return null;

  if (/mpegurl/.test(ct) || HLS_EXT.test(path)) {
    return { url: details.url, kind: "hls", ct, size: null };
  }

  const looksVideo = ct.startsWith("video/") || (VIDEO_EXT.test(path) && (ct === "" || ct === "application/octet-stream"));
  if (!looksVideo) return null;

  const size = totalSize(h);
  if (size !== null && size < MIN_FILE_BYTES) return null;
  return { url: details.url, kind: "file", ct, size };
}

function record(tabId, entry) {
  queue = queue.then(async () => {
    const k = key(tabId);
    const list = (await chrome.storage.session.get(k))[k] || [];
    if (list.some((e) => e.url === entry.url)) return;
    list.push({ ...entry, at: Date.now() });
    if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB);
    await chrome.storage.session.set({ [k]: list });
    chrome.action.setBadgeText({ tabId, text: String(list.length) }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#f15f2c" }).catch(() => {});
  }).catch(() => {});
}

function clearTab(tabId) {
  queue = queue.then(() => chrome.storage.session.remove(key(tabId))).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
}

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
