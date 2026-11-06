#!/usr/bin/env python3
"""Native messaging host for Video Downloader.

Lets the extension use a local yt-dlp for sites whose players can't be saved
from the browser (separate video/audio streams, signed URLs, ...).

Messages (JSON, Chrome native messaging framing):
  {"type": "info", "url": ...}                      -> title, duration, qualities
  {"type": "download", "id", "url", "height", "dir", "name", "skip"}
  {"type": "merge", "id", "video", "audio", "duration", "dir", "name", "skip"}
      -> {"type": "progress"|"done"|"skipped"|"failed", "id", ...}
  {"type": "ping"}                                  -> {"ok", "ytdlp", "ffmpeg"}
"""

import json
import os
import re
import shutil
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

# Chrome starts hosts with a minimal PATH; add the usual Homebrew locations.
os.environ["PATH"] = os.pathsep.join(["/opt/homebrew/bin", "/usr/local/bin", os.environ.get("PATH", "")])
YTDLP = shutil.which("yt-dlp")
FFMPEG = shutil.which("ffmpeg")
INFO_TIMEOUT_S = 90

_write_lock = threading.Lock()
LOG_FILE = os.path.expanduser("~/Library/Logs/Video Downloader/helper.log")
_logged_steps = {}


def log(text):
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [{os.getpid()}] {text}\n")
    except OSError:
        pass


def send(message):
    kind = message.get("type")
    if kind == "progress" and "percent" in message:
        step = message["percent"] // 10
        if _logged_steps.get(message.get("id")) != step:  # one line per 10%
            _logged_steps[message.get("id")] = step
            log(f"{message.get('id')} progress {message['percent']}%")
    elif kind == "progress" and "stage" in message:
        log(f"{message.get('id')} {message['stage']}")
    elif kind in ("done", "failed", "skipped"):
        log(f"{message.get('id')} {kind} {message.get('error') or message.get('file') or ''}")
    data = json.dumps(message).encode("utf-8")
    try:
        with _write_lock:
            sys.stdout.buffer.write(struct.pack("<I", len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    except (BrokenPipeError, ValueError):
        log("extension closed the connection; message dropped")


def read():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def last_error(text):
    lines = [l for l in (text or "").strip().splitlines() if l.strip()]
    errors = [l for l in lines if l.startswith("ERROR")]
    return (errors or lines or ["yt-dlp failed"])[-1].replace("ERROR: ", "")


def info(request):
    if not YTDLP:
        return send({"error": "yt-dlp is not installed. Run: brew install yt-dlp ffmpeg"})
    try:
        proc = subprocess.run(
            [YTDLP, "-J", "--no-playlist", "--no-warnings", request["url"]],
            capture_output=True, text=True, timeout=INFO_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return send({"error": "yt-dlp took too long to read this page"})
    if proc.returncode != 0:
        return send({"error": last_error(proc.stderr)})

    data = json.loads(proc.stdout)
    formats = data.get("formats") or []
    audio_size = max(
        (f.get("filesize") or f.get("filesize_approx") or 0
         for f in formats if f.get("vcodec") == "none" and f.get("acodec") not in (None, "none")),
        default=0,
    )
    by_height = {}
    for f in formats:
        height = f.get("height")
        if not height or f.get("vcodec") in (None, "none"):
            continue
        size = f.get("filesize") or f.get("filesize_approx") or 0
        if f.get("acodec") in (None, "none"):
            size += audio_size  # video-only stream will be merged with audio
        by_height[height] = max(by_height.get(height, 0), size)

    qualities = [{"height": h, "size": s} for h, s in sorted(by_height.items(), reverse=True)]
    send({
        "title": data.get("title") or "",
        "duration": data.get("duration") or 0,
        "site": data.get("extractor_key") or "",
        "qualities": qualities,
        "audioSize": audio_size,
    })


PROGRESS_RE = re.compile(r"^vd-progress:(\S+)/(\S+)/(\S+)$")


def download(request):
    job = request["id"]
    if not YTDLP:
        return send({"type": "failed", "id": job, "error": "yt-dlp is not installed. Run: brew install yt-dlp ffmpeg"})

    folder = os.path.expanduser(request["dir"])
    os.makedirs(folder, exist_ok=True)
    height = int(request.get("height") or 0)
    fmt = f"bv*[height<={height}]+ba/b[height<={height}]" if height else "ba/b"

    args = [
        YTDLP, "--no-playlist", "--newline", "--no-warnings",
        "-f", fmt,
        "-o", os.path.join(folder, request["name"] + ".%(ext)s"),
        "--progress-template", "download:vd-progress:%(progress.downloaded_bytes)s/%(progress.total_bytes)s/%(progress.total_bytes_estimate)s",
        "--no-overwrites" if request.get("skip", True) else "--force-overwrites",
    ]
    if height:
        args += ["--merge-output-format", "mp4"]
    else:
        args += ["-x", "--audio-format", "m4a"]
    args.append(request["url"])

    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    output, part, skipped, saved = [], 0, False, ""
    for line in proc.stdout:
        line = line.strip()
        output.append(line)
        match = PROGRESS_RE.match(line)
        if match:
            done, total, estimate = (float(x) if x not in ("NA", "None") else 0 for x in match.groups())
            total = total or estimate
            send({"type": "progress", "id": job, "downloaded": done, "total": total, "part": part})
        elif line.startswith("[download] Destination:"):
            part += 1
            saved = line.split(":", 1)[1].strip()
        elif "has already been downloaded" in line:
            skipped = True
        elif line.startswith("[Merger]") or line.startswith("[ExtractAudio]"):
            send({"type": "progress", "id": job, "stage": "Merging…"})
            quoted = re.search(r'"(.+)"', line)
            if quoted:
                saved = quoted.group(1)
    proc.wait()

    if proc.returncode != 0:
        send({"type": "failed", "id": job, "error": last_error("\n".join(output))})
    elif skipped:
        send({"type": "skipped", "id": job})
    else:
        send({"type": "done", "id": job, "file": saved})


USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
CHUNK_BYTES = 8 * 1024 * 1024


def _ssl_context():
    """python.org builds of Python ship without CA certificates on macOS, so
    point them at certifi or the system bundle instead of the empty default."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    for bundle in ("/etc/ssl/cert.pem", "/opt/homebrew/etc/ca-certificates/cert.pem", "/usr/local/etc/ca-certificates/cert.pem"):
        if os.path.exists(bundle):
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


SSL_CONTEXT = _ssl_context()


def _open(url, referer):
    headers = {"User-Agent": USER_AGENT}
    if referer:
        headers["Referer"] = referer
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60, context=SSL_CONTEXT)


def _copy(response, out, on_bytes):
    copied = 0
    while True:
        block = response.read(1 << 20)
        if not block:
            return copied
        out.write(block)
        copied += len(block)
        on_bytes(len(block))


def fetch_to_file(url, path, chunk_param, referer, on_bytes):
    """Saves a stream to `path`. Tries one plain request first; servers that only
    answer ranged requests (?bytes=a-b, as the player used) are read in chunks."""
    try:
        with _open(url, referer) as response, open(path, "wb") as out:
            _copy(response, out, on_bytes)
        return
    except urllib.error.HTTPError as e:
        if not chunk_param or e.code not in (400, 403, 404, 416):
            raise

    separator = "&" if "?" in url else "?"
    start, total = 0, None
    with open(path, "wb") as out:
        while total is None or start < total:
            end = start + CHUNK_BYTES - 1 if total is None else min(start + CHUNK_BYTES, total) - 1
            with _open(f"{url}{separator}{chunk_param}={start}-{end}", referer) as response:
                content_range = response.headers.get("Content-Range") or ""
                if "/" in content_range and content_range.rsplit("/", 1)[1].isdigit():
                    total = int(content_range.rsplit("/", 1)[1])
                copied = _copy(response, out, on_bytes)
            if copied == 0:
                break
            start += copied
            if total is None and copied < CHUNK_BYTES:
                break


def merge(request):
    """Downloads a video-only and an audio-only stream and muxes them (no re-encode)."""
    job = request["id"]
    if not FFMPEG:
        return send({"type": "failed", "id": job, "error": "ffmpeg is not installed. Run: brew install ffmpeg"})

    folder = os.path.expanduser(request["dir"])
    os.makedirs(folder, exist_ok=True)
    target = os.path.join(folder, request["name"] + ".mp4")
    if request.get("skip", True) and os.path.exists(target) and os.path.getsize(target) > 0:
        return send({"type": "skipped", "id": job})
    if os.path.exists(target):
        stem, n = target[:-4], 2
        while os.path.exists(f"{stem} ({n}).mp4"):
            n += 1
        target = f"{stem} ({n}).mp4"

    work = os.path.join(folder, f".video-downloader-{job}")
    os.makedirs(work, exist_ok=True)
    video_file, audio_file = os.path.join(work, "video.mp4"), os.path.join(work, "audio.mp4")
    partial = os.path.join(work, "merged.mp4")
    referer = request.get("referer") or ""
    expected = int(request.get("videoSize") or 0) + int(request.get("audioSize") or 0)
    state = {"done": 0, "last": 0.0}

    def on_bytes(n):
        state["done"] += n
        now = time.monotonic()
        if now - state["last"] < 0.5:
            return
        state["last"] = now
        if expected:
            send({"type": "progress", "id": job, "percent": min(95, int(state["done"] / expected * 95)), "label": "downloading video and audio"})
        else:
            send({"type": "progress", "id": job, "downloaded": state["done"], "total": 0})

    try:
        fetch_to_file(request["video"], video_file, request.get("videoChunkParam"), referer, on_bytes)
        fetch_to_file(request["audio"], audio_file, request.get("audioChunkParam"), referer, on_bytes)

        send({"type": "progress", "id": job, "stage": "Merging…"})
        proc = subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", video_file, "-i", audio_file,
             "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", partial],
            capture_output=True, text=True,
        )
        if proc.returncode != 0 or not os.path.exists(partial):
            raise RuntimeError(last_error(proc.stderr) if proc.stderr.strip() else "ffmpeg failed")
        os.replace(partial, target)
        send({"type": "done", "id": job, "file": target})
    except urllib.error.HTTPError as e:
        send({"type": "failed", "id": job, "error": f"Server returned {e.code} {e.reason}"})
    except Exception as e:  # network errors, disk errors, ffmpeg errors
        send({"type": "failed", "id": job, "error": str(e) or e.__class__.__name__})
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    while True:
        request = read()
        if request is None:
            log("connection closed by the extension")
            break
        kind = request.get("type")
        if kind in ("download", "merge"):
            log(f"{request.get('id')} start {kind} -> {request.get('dir')}/{request.get('name')}")
        if kind == "info":
            info(request)  # one-shot messages: answer and let Chrome close us
        elif kind == "download":
            threading.Thread(target=download, args=(request,), daemon=False).start()
        elif kind == "merge":
            threading.Thread(target=merge, args=(request,), daemon=False).start()
        elif kind == "ping":
            send({"ok": True, "ytdlp": bool(YTDLP), "ffmpeg": bool(FFMPEG)})


if __name__ == "__main__":
    main()
