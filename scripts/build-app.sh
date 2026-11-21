#!/bin/sh
# Builds apps/mac/build/Margin.app with margind compiled inside it (ad-hoc signed until
# there's a Developer ID). The server and GitHub app it uses are fixed at build time:
#   MARGIN_SERVER              default http://127.0.0.1:8787 (bun run dev)
#   MARGIN_GITHUB_CLIENT_ID    default none (only dev sign-in works)
set -eu
server=${MARGIN_SERVER:-http://127.0.0.1:8787}
client_id=${MARGIN_GITHUB_CLIENT_ID:-}
case "$server$client_id" in *[\<\>\&\"]*) echo "invalid MARGIN_SERVER or MARGIN_GITHUB_CLIENT_ID" >&2; exit 1 ;; esac
root=$(cd "$(dirname "$0")/.." && pwd)
mac="$root/apps/mac"
config=${1:-release}

swift build -c "$config" --package-path "$mac" >/dev/null
binary="$(swift build -c "$config" --package-path "$mac" --show-bin-path)/Margin"

app="$mac/build/Margin.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$binary" "$app/Contents/MacOS/Margin"
bun build --compile --target=bun-darwin-arm64 "$root/apps/margind/src/main.ts" \
  --outfile "$app/Contents/MacOS/margind" >/dev/null
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.margin.app</string>
  <key>CFBundleName</key><string>Margin</string>
  <key>CFBundleDisplayName</key><string>Margin</string>
  <key>CFBundleExecutable</key><string>Margin</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>MarginServer</key><string>$server</string>
  <key>MarginGitHubClientID</key><string>$client_id</string>
</dict>
</plist>
PLIST
# Inside out: the helper first, then the app around it.
codesign --force --sign - "$app/Contents/MacOS/margind" >/dev/null 2>&1
codesign --force --sign - "$app" >/dev/null 2>&1
echo "$app"
