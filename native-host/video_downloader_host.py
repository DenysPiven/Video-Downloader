#!/usr/bin/env python3
"""Native messaging host for Video Downloader.

Lets the extension use a local yt-dlp for sites whose players can't be saved
from the browser (separate video/audio streams, signed URLs, ...).

Messages (JSON, Chrome native messaging framing):
  {"type": "info", "url": ...}                      -> title, duration, qualities
  {"type": "download", "id", "url", "height", "dir", "name", "skip"}
      -> {"type": "progress"|"done"|"skipped"|"failed", "id", ...}
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading

# Chrome starts hosts with a minimal PATH; add the usual Homebrew locations.
os.environ["PATH"] = os.pathsep.join(["/opt/homebrew/bin", "/usr/local/bin", os.environ.get("PATH", "")])
YTDLP = shutil.which("yt-dlp")
INFO_TIMEOUT_S = 90

_write_lock = threading.Lock()


def send(message):
    data = json.dumps(message).encode("utf-8")
    with _write_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


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


def main():
    while True:
        request = read()
        if request is None:
            break
        kind = request.get("type")
        if kind == "info":
            info(request)  # one-shot messages: answer and let Chrome close us
        elif kind == "download":
            threading.Thread(target=download, args=(request,), daemon=False).start()
        elif kind == "ping":
            send({"ok": True, "ytdlp": bool(YTDLP)})


if __name__ == "__main__":
    main()
