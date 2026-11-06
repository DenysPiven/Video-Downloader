// Settings shared by the popup and the settings page (chrome.storage.local).

import { safeName } from "./util.js";

export const DEFAULTS = {
  folderMode: "downloads",      // "downloads" (subfolder of Downloads) | "custom" (any folder via picker)
  subfolder: "Video Downloader",
  customName: "",               // display name of the custom folder
  skip: true,                   // skip files that already exist
  recentFolders: [],            // recent Downloads subfolders
};
const LEGACY_SUBFOLDER = "video-downloader";

export async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  if (s.subfolder === LEGACY_SUBFOLDER) {
    s.subfolder = DEFAULTS.subfolder;
    await chrome.storage.local.set({ subfolder: s.subfolder });
  }
  return s;
}

export function saveSettings(patch) {
  return chrome.storage.local.set(patch);
}

// "Shows/ ../My: Show" -> "Shows/My_ Show"; strips unsafe parts and "..".
export function cleanFolder(s) {
  return String(s || "")
    .split(/[\\/]+/)
    .map((p) => safeName(p, ""))
    .filter((p) => p && p !== "." && p !== "..")
    .join("/");
}

export const downloadsLabel = (folder) => (folder ? `Downloads/${folder}` : "Downloads");

export function folderLabel(s) {
  return s.folderMode === "custom" && s.customName ? s.customName : downloadsLabel(cleanFolder(s.subfolder));
}
