#!/bin/sh
# Builds, signs and publishes a Margin.app release; installed copies update themselves.
#   bun run release
# Needs a clean, committed tree. The build number is the commit count, so each release
# is newer than the last. Signing uses the Sparkle key in this Mac's Keychain (account
# "margin"); uploading uses the release token saved there by the server setup.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
server=${MARGIN_SERVER:-https://margin-api.fly.dev}
export MARGIN_SERVER=$server
export MARGIN_GITHUB_CLIENT_ID=${MARGIN_GITHUB_CLIENT_ID:-Ov23lih46hAtRfO5kTd3}

if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "commit your changes first: a release is built from what's committed" >&2
  exit 1
fi
# Every string in the app translated, and the catalog in step with the code, so a release
# never goes out half in English.
if ! "$root/scripts/strings.sh"; then
  echo "translate the missing strings first (bun run strings lists them), then commit" >&2
  exit 1
fi
if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "the string catalog was behind the code: translate what's new, commit apps/mac/Resources/Localizable.xcstrings" >&2
  exit 1
fi
export MARGIN_BUILD=$(git -C "$root" rev-list --count HEAD)
export MARGIN_VERSION=0.1.$MARGIN_BUILD

zip=$("$root/scripts/package.sh")
signature=$("$root/apps/mac/.build/artifacts/sparkle/Sparkle/bin/sign_update" --account margin -p "$zip")

# The token goes to curl in a private file, not on the command line.
headers=$(mktemp)
trap 'rm -f "$headers"' EXIT
chmod 600 "$headers"
printf 'authorization: Bearer %s\n' "$(security find-generic-password -s margin-release -a release-token -w)" > "$headers"
curl -fsS -X POST "$server/updates/releases" -H @"$headers" \
  -H "x-release-version: $MARGIN_VERSION" -H "x-release-build: $MARGIN_BUILD" \
  -H "x-release-signature: $signature" -H "x-release-min-system: 26.0" \
  -H "content-type: application/zip" --data-binary @"$zip"
echo
curl -fsS -X POST "$server/updates/releases/$MARGIN_BUILD/dmg" -H @"$headers" \
  -H "content-type: application/x-apple-diskimage" --data-binary @"$root/apps/mac/build/Margin.dmg"
echo
echo "released Margin $MARGIN_VERSION (build $MARGIN_BUILD): $server/download"
