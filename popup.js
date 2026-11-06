import { QUALITIES, QUALITY_LABELS, parseBoostyPost, loadBoostyPosts } from "./boosty.js";
import { safeName, extFromUrl, formatSize } from "./util.js";

const $ = (id) => document.getElementById(id);
let items = []; // { checkbox, kind, getUrl(), name }

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").className = isError ? "err" : "";
}

function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function updateButton() {
  const n = items.filter((i) => i.checkbox.checked).length;
  $("download").disabled = n === 0;
  $("download").textContent = n ? `Download ${n} video${n === 1 ? "" : "s"}` : "Download";
}

function addRow(parent, { label, fmt, meta, select, kind, getUrl, name }) {
  const checkbox = el("input", { type: "checkbox", checked: true });
  checkbox.addEventListener("change", updateButton);
  const text = el("span", { className: "name", title: label, textContent: label });
  text.addEventListener("click", () => { checkbox.checked = !checkbox.checked; updateButton(); });
  const row = el("div", { className: "row" }, [
    checkbox,
    text,
    fmt ? el("span", { className: "fmt", textContent: fmt }) : null,
    meta ? el("span", { className: "meta", textContent: meta }) : null,
    select,
  ]);
  row.style.animationDelay = `${Math.min(items.length, 10) * 25}ms`;
  parent.append(row);
  items.push({ checkbox, kind, getUrl, name });
}

function sectionHead(title, from) {
  const toggle = el("button", { className: "link", textContent: "Select none" });
  toggle.addEventListener("click", () => {
    const mine = items.slice(from, from + toggle._count);
    const anyOn = mine.some((i) => i.checkbox.checked);
    for (const i of mine) i.checkbox.checked = !anyOn;
    toggle.textContent = anyOn ? "Select all" : "Select none";
    updateButton();
  });
  const head = el("div", { className: "sec-head" }, [el("span", { className: "label", textContent: title }), toggle]);
  head.setCount = (n) => { toggle._count = n; toggle.hidden = n < 2; };
  return head;
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

  const start = items.length;
  const head = sectionHead(`Boosty · ${posts.length} open post${posts.length === 1 ? "" : "s"}`, start);
  const box = el("section", {}, [head]);
  $("list").append(box);
  const { results, errors, loggedIn } = await loadBoostyPosts(posts);
  if (!loggedIn) box.append(el("div", { className: "note", textContent: "Not logged in to Boosty, so only free posts are available." }));

  for (const post of results) {
    if (!post.hasAccess || post.videos.length === 0) {
      box.append(el("div", { className: "post-title", textContent: post.title }));
      box.append(el("div", { className: "note", textContent: post.hasAccess ? "No videos in this post." : "No access from this account." }));
      continue;
    }
    if (post.videos.length > 1) box.append(el("div", { className: "post-title", textContent: post.title }));
    post.videos.forEach((v, i) => {
      const select = el("select");
      for (const q of QUALITIES) if (v.urls[q]) select.append(el("option", { value: q, textContent: QUALITY_LABELS[q] }));
      const num = post.videos.length > 1 ? ` - ${String(i + 1).padStart(2, "0")}` : "";
      const extra = v.title && post.videos.length > 1 ? ` ${safeName(v.title)}` : "";
      addRow(box, {
        label: post.videos.length > 1 ? (v.title || `Video ${i + 1}`) : post.title,
        select,
        kind: "file",
        getUrl: () => v.urls[select.value],
        name: `${safeName(post.title)}${num}${extra}.mp4`,
      });
    });
  }
  for (const e of errors) box.append(el("div", { className: "note err", textContent: e }));
  head.setCount(items.length - start);
  return items.length - start;
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
  const k = `tab_${tab.id}`;
  const sniffed = (await chrome.storage.session.get(k))[k] || [];
  const entries = new Map(sniffed.map((e) => [e.url, e]));
  for (const url of await videosInPage(tab.id)) {
    if (!entries.has(url)) entries.set(url, { url, kind: /\.m3u8(\?|#|$)/i.test(url) ? "hls" : "file", size: null });
  }
  const list = [...entries.values()];
  if (list.length === 0) return 0;

  const start = items.length;
  const head = sectionHead("On this page", start);
  const box = el("section", {}, [head]);
  $("list").append(box);

  const title = safeName(tab.title, "video");
  list.forEach((e, i) => {
    const num = list.length > 1 ? ` ${String(i + 1).padStart(2, "0")}` : "";
    let host = "";
    try { host = new URL(e.url).hostname.replace(/^www\./, ""); } catch {}
    const file = decodeURIComponent(e.url.split(/[?#]/)[0].split("/").pop() || "").slice(0, 60);
    const ext = extFromUrl(e.url, e.ct);
    addRow(box, {
      label: file || host,
      fmt: e.kind === "hls" ? "HLS" : ext.toUpperCase(),
      meta: e.size ? formatSize(e.size) : host,
      kind: e.kind,
      getUrl: () => e.url,
      name: e.kind === "hls" ? `${title}${num}` : `${title}${num}.${ext}`, // HLS extension is set after parsing
    });
  });
  head.setCount(list.length);
  return list.length;
}

function renderEmpty() {
  $("list").append(el("div", { className: "empty" }, [
    el("img", { src: "icons/logo.svg", width: 56, height: 56, alt: "" }),
    el("strong", { textContent: "No videos found yet" }),
    el("span", { textContent: "Start playing the video, then scan again. Tabs opened before the extension was installed need a reload." }),
  ]));
}

// ---------- Main ----------

async function showFolder() {
  const { folderName } = await chrome.storage.local.get("folderName");
  $("folder").textContent = folderName || "Choose on first download";
  $("folder").classList.toggle("none", !folderName);
}

async function openManager() {
  const url = chrome.runtime.getURL("manager.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function scan() {
  items = [];
  $("list").replaceChildren();
  updateButton();
  setStatus("Looking for videos…");

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const boostyTabs = await chrome.tabs.query({ url: "https://boosty.to/*" });

  let total = 0;
  try { total += await renderBoosty(boostyTabs); } catch (e) { setStatus(`Boosty: ${e.message}`, true); }
  if (active && !parseBoostyPost(active.url || "")) total += await renderCurrentTab(active);

  if (!total) renderEmpty();
  setStatus(total ? `${total} video${total === 1 ? "" : "s"} found` : "");
  updateButton();
}

async function downloadSelected() {
  const picked = items.filter((i) => i.checkbox.checked);
  if (!picked.length) return;
  const { queue = [] } = await chrome.storage.session.get("queue");
  for (const it of picked) {
    queue.push({ id: crypto.randomUUID(), url: it.getUrl(), kind: it.kind, name: it.name });
  }
  await chrome.storage.session.set({ queue });
  await openManager();
  window.close();
}

$("refresh").addEventListener("click", scan);
$("download").addEventListener("click", downloadSelected);
$("change").addEventListener("click", openManager);
showFolder();
scan().catch((e) => setStatus(`Error: ${e.message}`, true));
