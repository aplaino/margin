#!/bin/sh
# Builds Margin.zip (what updates download) and Margin.dmg (what first installs download,
# with an Applications shortcut to drag onto). Needs the real server and GitHub app:
#   MARGIN_SERVER=https://… MARGIN_GITHUB_CLIENT_ID=… bun run package
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
: "${MARGIN_SERVER:?set MARGIN_SERVER to the server's https:// address}"
: "${MARGIN_GITHUB_CLIENT_ID:?set MARGIN_GITHUB_CLIENT_ID to the GitHub OAuth app's client ID}"
case "$MARGIN_SERVER" in https://*) ;; *) echo "MARGIN_SERVER must be https://" >&2; exit 1 ;; esac
app=$("$root/scripts/build-app.sh" release)
zip="$root/apps/mac/build/Margin.zip"
rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"

image="$root/apps/mac/build/Margin.dmg"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
ditto "$app" "$staging/Margin.app"
ln -s /Applications "$staging/Applications"
rm -f "$image"
hdiutil create -quiet -volname Margin -srcfolder "$staging" -ov -format UDZO "$image"
echo "$zip"
