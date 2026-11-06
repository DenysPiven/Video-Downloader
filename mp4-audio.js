// Tells which tracks an MP4 file has by reading only its beginning.
// Split-stream players (DASH) serve video and audio as separate files: the
// video-only ones are silent on their own and need the audio file merged in.

const HEADER_BYTES = 512 * 1024;

const isTag = (u8, i, tag) =>
  u8[i] === tag.charCodeAt(0) && u8[i + 1] === tag.charCodeAt(1) && u8[i + 2] === tag.charCodeAt(2) && u8[i + 3] === tag.charCodeAt(3);

// { audio, video }: true = the track is declared; false = the whole track list
// (moov) was read and has no such track; null = can't tell from these bytes.
export function tracksFromHeader(u8) {
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
  const complete = moovEnd > 0 && moovEnd <= u8.length;
  const has = (type) => (handlers.includes(type) ? true : complete && handlers.length ? false : null);
  return { audio: has("soun"), video: has("vide") };
}

// Kept for callers that only need the audio answer.
export const audioFromHeader = (u8) => tracksFromHeader(u8).audio;

export async function probeTracks(url) {
  try {
    const res = await fetch(url, { credentials: "include", headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } });
    if (!res.ok || !res.body) return { audio: null, video: null };
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
    return tracksFromHeader(buf.subarray(0, len));
  } catch {
    return { audio: null, video: null };
  }
}
