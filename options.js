import { idbSet, folderAccess } from "./store.js";
import { DEFAULTS, loadSettings, saveSettings, cleanFolder, downloadsLabel } from "./settings.js";

const MAX_RECENT = 8;
const $ = (id) => document.getElementById(id);
const FOLDER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

let settings = { ...DEFAULTS };
let access = { dir: null, permission: null };

// ---------- Folder choices ----------

async function chooseCustom() {
  try {
    const dir = await window.showDirectoryPicker({ id: "video-downloader", mode: "readwrite", startIn: "videos" });
    await idbSet("dir", dir);
    await saveSettings({ folderMode: "custom", customName: dir.name });
    await refresh();
  } catch (e) {
    if (e.name !== "AbortError") showBanner(`Can't use that folder: ${e.message}`, "Try again", chooseCustom);
  }
}

async function useDownloadsFolder(folder) {
  const recent = [folder, ...settings.recentFolders.filter((f) => f !== folder)].slice(0, MAX_RECENT);
  await saveSettings({ folderMode: "downloads", subfolder: folder, recentFolders: recent });
  await refresh();
}

async function allowAccess() {
  if (!access.dir) return chooseCustom();
  await access.dir.requestPermission({ mode: "readwrite" });
  await refresh();
}

// Subfolders of Downloads that already hold downloads, newest first.
async function foldersFromHistory() {
  const { downloadsRoot } = await chrome.storage.local.get("downloadsRoot");
  if (!downloadsRoot) return [];
  const root = `${downloadsRoot.replace(/\\/g, "/")}/`;
  const found = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 300, exists: true, state: "complete" });
  const out = [];
  for (const d of found) {
    const file = (d.filename || "").replace(/\\/g, "/");
    if (!file.startsWith(root)) continue;
    const rel = file.slice(root.length);
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    if (dir && !out.includes(dir)) out.push(dir);
  }
  return out;
}

async function reveal() {
  if (settings.folderMode === "downloads") {
    const folder = cleanFolder(settings.subfolder);
    const sep = "[\\\\/]";
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (folder) {
      const [last] = await chrome.downloads.search({
        filenameRegex: `${sep}${escape(folder).replace(/\//g, sep)}${sep}[^\\\\/]+$`,
        orderBy: ["-startTime"], limit: 1, exists: true, state: "complete",
      });
      if (last) return chrome.downloads.show(last.id);
    }
  }
  chrome.downloads.showDefaultFolder();
}

// ---------- Rendering ----------

function showBanner(text, action, handler) {
  $("banner-text").textContent = text;
  $("banner-btn").textContent = action;
  $("banner-btn").onclick = handler;
  $("banner").hidden = false;
}

function folderButton(folder, current) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `folder${current ? " current" : ""}`;
  b.innerHTML = `${FOLDER_ICON}<span class="f-name"></span><span class="f-tag">${current ? "Current" : ""}</span>`;
  b.querySelector(".f-name").textContent = downloadsLabel(folder);
  b.addEventListener("click", () => useDownloadsFolder(folder));
  return b;
}

async function render() {
  const custom = settings.folderMode === "custom" && access.dir;
  const current = custom ? null : cleanFolder(settings.subfolder);

  $("path").textContent = custom ? access.dir.name : downloadsLabel(current);
  $("path-note").textContent = custom
    ? "A folder you picked. Files are written straight into it."
    : "Inside your Downloads folder.";
  $("reveal").hidden = Boolean(custom); // the picker doesn't expose a path to reveal

  $("banner").hidden = true;
  if (custom && access.permission !== "granted") {
    showBanner(`Chrome needs your permission to save into “${access.dir.name}”.`, "Allow", allowAccess);
  }

  const folders = [];
  for (const f of [DEFAULTS.subfolder, ...settings.recentFolders, ...(await foldersFromHistory())]) {
    if (f && !folders.includes(f)) folders.push(f);
  }
  if (current && !folders.includes(current)) folders.unshift(current);
  $("folders").replaceChildren(folderButton("", current === ""), ...folders.map((f) => folderButton(f, f === current)));

  $("skip").checked = settings.skip;
}

async function refresh() {
  settings = await loadSettings();
  access = await folderAccess();
  if (settings.folderMode === "custom" && !access.dir) settings.folderMode = "downloads";
  await render();
}

// ---------- Init ----------

$("choose").addEventListener("click", chooseCustom);
$("reveal").addEventListener("click", reveal);
$("skip").addEventListener("change", (e) => saveSettings({ skip: e.target.checked }));
$("new-folder").addEventListener("submit", (e) => {
  e.preventDefault();
  const folder = cleanFolder($("new-folder-input").value);
  if (!folder) return;
  $("new-folder-input").value = "";
  useDownloadsFolder(folder);
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local") refresh(); });
window.addEventListener("focus", refresh);

await refresh();
