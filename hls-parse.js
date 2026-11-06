// Minimal HLS playlist parsing (no network), kept separate so it can be tested.

export function attrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

function parseRange(spec, prevEnd) {
  const [len, off] = spec.split("@");
  const start = off !== undefined ? Number(off) : prevEnd + 1;
  return { start, end: start + Number(len) - 1 };
}

export function isMaster(text) {
  return /#EXT-X-STREAM-INF/.test(text);
}

// -> [{ bandwidth, resolution, height, audioGroup, url }] sorted best first,
//    plus which audio groups live in separate playlists.
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const separateAudio = new Set();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#EXT-X-MEDIA:")) {
      const a = attrs(l.slice(13));
      if (a.TYPE === "AUDIO" && a.URI) separateAudio.add(a["GROUP-ID"]);
    } else if (l.startsWith("#EXT-X-STREAM-INF:")) {
      const a = attrs(l.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
      if (j >= lines.length) continue;
      const res = a.RESOLUTION || "";
      variants.push({
        bandwidth: Number(a.BANDWIDTH) || 0,
        resolution: res,
        height: Number(res.split("x")[1]) || 0,
        audioGroup: a.AUDIO || null,
        url: new URL(lines[j], baseUrl).href,
      });
      i = j;
    }
  }
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return { variants, separateAudio };
}

// -> { segments: [{url, range}], init: {url, range} | null, encrypted, live }
export function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const segments = [];
  let init = null;
  let encrypted = null;
  let pendingRange = null;
  const lastEnd = new Map(); // url -> last byte for implicit byte-range offsets

  for (const l of lines) {
    if (!l) continue;
    if (l.startsWith("#EXT-X-KEY:")) {
      const a = attrs(l.slice(11));
      if (a.METHOD && a.METHOD !== "NONE") encrypted = a.METHOD;
    } else if (l.startsWith("#EXT-X-MAP:")) {
      const a = attrs(l.slice(11));
      const url = new URL(a.URI, baseUrl).href;
      init = { url, range: a.BYTERANGE ? parseRange(a.BYTERANGE, -1) : null };
    } else if (l.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = l.slice(17);
    } else if (!l.startsWith("#")) {
      const url = new URL(l, baseUrl).href;
      let range = null;
      if (pendingRange) {
        range = parseRange(pendingRange, lastEnd.has(url) ? lastEnd.get(url) : -1);
        lastEnd.set(url, range.end);
        pendingRange = null;
      }
      segments.push({ url, range });
    }
  }
  return { segments, init, encrypted, live: !/#EXT-X-ENDLIST/.test(text) };
}
