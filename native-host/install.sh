#!/bin/bash
# Registers the yt-dlp helper with Chrome (macOS).
# Usage: ./install.sh <extension-id>   (the ID is shown on chrome://extensions)
set -euo pipefail

EXT_ID="${1:?Usage: ./install.sh <extension-id>  (copy the ID from chrome://extensions)}"
HOST_NAME="com.video_downloader.host"
DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || { echo "python3 not found" >&2; exit 1; }

# Chrome launches hosts with a bare environment, so pin the interpreter path.
RUNNER="$DIR/run-host.sh"
cat > "$RUNNER" <<EOF
#!/bin/bash
exec "$PYTHON" "$DIR/video_downloader_host.py" "\$@"
EOF
chmod +x "$RUNNER" "$DIR/video_downloader_host.py"

TARGET="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$TARGET"
cat > "$TARGET/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Video Downloader helper (yt-dlp)",
  "path": "$RUNNER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo "Installed $HOST_NAME for extension $EXT_ID"
command -v yt-dlp >/dev/null || echo "Note: yt-dlp not found. Install it with: brew install yt-dlp ffmpeg"
