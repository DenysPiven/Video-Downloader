import { QUALITIES, QUALITY_LABELS, parseBoostyPost, loadBoostyPosts } from "./boosty.js";
import { safeName, extFromUrl, formatSize } from "./util.js";

const ROOT = "Video Downloader";
const $ = (id) => document.getElementById(id);
let items = []; // { checkbox, stateEl, getUrl(), kind, filename }

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").className = isError ? "err" : "";
}

function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function addRow(parent, { name, tag, meta, select, kind, getUrl, filename }) {
  const checkbox = el("input", { type: "checkbox", checked: true });
  const stateEl = el("span", { className: "state" });
  parent.append(el("div", { className: "row" }, [
    el("label", { title: name }, [checkbox, " ", name]),
    tag ? el("span", { className: "tag", textContent: tag }) : null,
    meta ? el("span", { className: "meta", textContent: meta }) : null,
    select,
    stateEl,
  ]));
  items.push({ checkbox, stateEl, kind, getUrl, filename });
}

// ---------- Boosty: all open boosty.to post tabs ----------

async function renderBoosty(allTabs) {
  const seen = new Set();
  const posts = [];
  for (const t of allTabs) {
    const p = parseBoostyPost(t.url || "");
    if (p && !seen.has(p.id)) { seen.add(p.id); posts.push(p); }
  }
  if (posts.length === 0) return 0;

  const box = el("section", {}, [el("h2", { textContent: `Boosty — open posts: ${posts.length}` })]);
  $("list").append(box);
  const { results, errors, loggedIn } = await loadBoostyPosts(posts);
  if (!loggedIn) box.append(el("div", { className: "note", textContent: "Not logged in to Boosty — only free posts are available." }));

  let count = 0;
  for (const post of results) {
    box.append(el("h3", { textContent: post.title }));
    if (!post.hasAccess) { box.append(el("div", { className: "note", textContent: "No access from this account." })); continue; }
    if (post.videos.length === 0) { box.append(el("div", { className: "note", textContent: "No videos found." })); continue; }
    post.videos.forEach((v, i) => {
      const select = el("select");
      for (const q of QUALITIES) if (v.urls[q]) select.append(el("option", { value: q, textContent: QUALITY_LABELS[q] }));
      const num = post.videos.length > 1 ? ` - ${String(i + 1).padStart(2, "0")}` : "";
      const base = `${safeName(post.title)}${num}${v.title && post.videos.length > 1 ? " " + safeName(v.title) : ""}`;
      addRow(box, {
        name: v.title || `${post.title}${num}`,
        select,
        kind: "file",
        getUrl: () => v.urls[select.value],
        filename: `${ROOT}/Boosty/${safeName(post.blog)}/${base}.mp4`,
      });
      count++;
    });
  }
  for (const e of errors) box.append(el("div", { className: "err", textContent: e }));
  return count;
}

// ---------- Any site: what the current tab loaded or embeds ----------

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
    return []; // chrome:// pages, the Web Store, etc.
  }
}

async function renderCurrentTab(tab) {
  const box = el("section", {}, [el("h2", { textContent: "On this page" })]);
  $("list").append(box);

  const k = `tab_${tab.id}`;
  const sniffed = (await chrome.storage.session.get(k))[k] || [];
  const entries = new Map(sniffed.map((e) => [e.url, e]));
  for (const url of await videosInPage(tab.id)) {
    if (!entries.has(url)) {
      entries.set(url, { url, kind: /\.m3u8(\?|#|$)/i.test(url) ? "hls" : "file", size: null });
    }
  }

  const list = [...entries.values()];
  if (list.length === 0) {
    box.append(el("div", { className: "note", textContent: "Nothing found yet. Start playing the video and click Refresh. If the page was open before the extension was installed, reload it." }));
    return 0;
  }

  const title = safeName(tab.title, "video");
  list.forEach((e, i) => {
    const num = list.length > 1 ? ` ${String(i + 1).padStart(2, "0")}` : "";
    let host = "";
    try { host = new URL(e.url).hostname; } catch {}
    const file = decodeURIComponent((e.url.split(/[?#]/)[0].split("/").pop() || "")).slice(0, 60);
    addRow(box, {
      name: `${file || host}`,
      tag: e.kind === "hls" ? "HLS" : extFromUrl(e.url, e.ct).toUpperCase(),
      meta: e.size ? formatSize(e.size) : host,
      kind: e.kind,
      getUrl: () => e.url,
      filename: `${ROOT}/${title}${num}`, // extension added at download time
    });
  });
  return list.length;
}

// ---------- Main ----------

async function scan() {
  items = [];
  $("list").replaceChildren();
  $("download").disabled = true;
  setStatus("Looking for videos…");

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const allTabs = await chrome.tabs.query({ url: "https://boosty.to/*" });

  let total = 0;
  try { total += await renderBoosty(allTabs); } catch (e) { setStatus(`Boosty: ${e.message}`, true); }
  if (active && !parseBoostyPost(active.url || "")) total += await renderCurrentTab(active);

  setStatus(total ? `Videos found: ${total}.` : "No videos found.");
  $("download").disabled = total === 0;
}

async function downloadSelected() {
  $("download").disabled = true;
  let files = 0, streams = 0;
  for (const it of items) {
    if (!it.checkbox.checked) continue;
    const url = it.getUrl();
    try {
      if (it.kind === "hls") {
        const q = new URLSearchParams({ src: url, name: it.filename });
        await chrome.tabs.create({ url: `hls.html?${q}`, active: false });
        it.stateEl.textContent = "separate tab";
        streams++;
      } else {
        const filename = /\.\w{2,4}$/.test(it.filename) ? it.filename : `${it.filename}.${extFromUrl(url)}`;
        await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
        it.stateEl.textContent = "queued ✓";
        files++;
      }
      it.stateEl.className = "state ok";
    } catch (e) {
      it.stateEl.textContent = "error";
      it.stateEl.title = e.message;
      it.stateEl.className = "state err";
    }
  }
  const parts = [];
  if (files) parts.push(`files sent to Chrome downloads: ${files}`);
  if (streams) parts.push(`HLS streams assembling in separate tabs: ${streams}`);
  setStatus(parts.length ? `${parts.join("; ")}. Folder: Downloads/${ROOT}.` : "Nothing selected.");
  $("download").disabled = false;
}

$("refresh").addEventListener("click", scan);
$("download").addEventListener("click", downloadSelected);
scan().catch((e) => setStatus(`Error: ${e.message}`, true));
