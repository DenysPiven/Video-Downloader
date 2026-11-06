// Tells whether an MP4 file has an audio track by reading only its beginning.
// Split-stream players (DASH) serve video and audio as separate files; the
// video-only ones play fine but are silent, so they must not win as "best".

const HEADER_BYTES = 512 * 1024;

const isTag = (u8, i, tag) =>
  u8[i] === tag.charCodeAt(0) && u8[i + 1] === tag.charCodeAt(1) && u8[i + 2] === tag.charCodeAt(2) && u8[i + 3] === tag.charCodeAt(3);

// true: an audio track is declared; false: the whole track list (moov) was read
// and has no audio; null: can't tell from these bytes.
export function audioFromHeader(u8) {
  const handlers = [];
  let moovEnd = -1;
  for (let i = 4; i + 16 <= u8.length; i++) {
    if (isTag(u8, i, "moov")) {
      const size = ((u8[i - 4] << 24) | (u8[i - 3] << 16) | (u8[i - 2] << 8) | u8[i - 1]) >>> 0;
      if (size >= 8) moovEnd = Math.max(moovEnd, i - 4 + size);
    } else if (isTag(u8, i, "hdlr")) {
      // hdlr box: type, version/flags (4), pre_defined (4), handler_type (4)
      handlers.push(String.fromCharCode(u8[i + 12], u8[i + 13], u8[i + 14], u8[i + 15]));
    }
  }
  if (handlers.includes("soun")) return true;
  if (handlers.includes("vide") && moovEnd > 0 && moovEnd <= u8.length) return false;
  return null;
}

export async function probeAudio(url) {
  try {
    const res = await fetch(url, { credentials: "include", headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const buf = new Uint8Array(HEADER_BYTES);
    let len = 0;
    while (len < HEADER_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const n = Math.min(value.length, HEADER_BYTES - len);
      buf.set(value.subarray(0, n), len);
      len += n;
    }
    reader.cancel().catch(() => {});
    return audioFromHeader(buf.subarray(0, len));
  } catch {
    return null;
  }
}
