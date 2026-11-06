// Boosty mode: reads posts from all open boosty.to tabs through Boosty's own API
// with your logged-in session and returns direct video files per quality.

export const QUALITIES = ["ultra_hd", "quad_hd", "full_hd", "high", "medium", "low", "lowest", "tiny"];
export const QUALITY_LABELS = {
  ultra_hd: "4K", quad_hd: "1440p", full_hd: "1080p", high: "720p",
  medium: "480p", low: "360p", lowest: "240p", tiny: "144p",
};

export function parseBoostyPost(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "boosty.to") return null;
    const m = u.pathname.match(/^\/([^/]+)\/posts\/([0-9a-f-]{36})/i);
    return m ? { blog: m[1], id: m[2] } : null;
  } catch {
    return null;
  }
}

async function accessToken() {
  try {
    const c = await chrome.cookies.get({ url: "https://boosty.to", name: "auth" });
    return c ? JSON.parse(decodeURIComponent(c.value)).accessToken || null : null;
  } catch {
    return null;
  }
}

// Returns [{ blog, title, hasAccess, videos: [{ title, urls: {quality: url} }] }]
// plus a list of error strings.
export async function loadBoostyPosts(posts) {
  const token = await accessToken();
  const results = [];
  const errors = [];
  for (const { blog, id } of posts) {
    try {
      const res = await fetch(
        `https://api.boosty.to/v1/blog/${encodeURIComponent(blog)}/post/${id}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const post = await res.json();
      const videos = (post.data || [])
        .filter((b) => b.type === "ok_video")
        .map((b) => {
          const urls = {};
          for (const p of b.playerUrls || []) {
            if (p && p.url && QUALITIES.includes(p.type)) urls[p.type] = p.url;
          }
          return { title: b.title || "", urls };
        })
        .filter((v) => Object.keys(v.urls).length > 0);
      results.push({ blog, title: post.title || "Без назви", hasAccess: post.hasAccess !== false, videos });
    } catch (e) {
      errors.push(`${blog}/${id.slice(0, 8)}: ${e.message}`);
    }
  }
  return { results, errors, loggedIn: Boolean(token) };
}
