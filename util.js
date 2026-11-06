export function safeName(s, fallback = "video") {
  const cleaned = String(s || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 120);
  return cleaned || fallback;
}

const CT_EXT = { "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv", "video/ogg": "ogv" };

export function extFromUrl(url, ct = "") {
  const m = String(url).split(/[?#]/)[0].match(/\.(mp4|webm|mov|mkv|m4v|ogv)$/i);
  if (m) return m[1].toLowerCase();
  return CT_EXT[ct] || "mp4";
}

export function formatSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} ГБ` : `${mb.toFixed(mb < 10 ? 1 : 0)} МБ`;
}
