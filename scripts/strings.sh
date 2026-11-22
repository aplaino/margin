#!/bin/sh
# Brings apps/mac/Resources/Localizable.xcstrings up to date with the app's source: the compiler
# lists every localizable string (Text("…"), LocalizedStringResource, String(localized:)), new ones
# are added for translation and ones no longer used are marked stale. Run it after changing copy,
# then translate what's new (Xcode opens the catalog, or edit the JSON).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
mac="$root/apps/mac"
out="$mac/.build/strings"
# A clean compile, so every file reports its strings, not just the ones that changed.
rm -rf "$out"
mkdir -p "$out/data"
swift build --package-path "$mac" --scratch-path "$out/build" \
  -Xswiftc -emit-localized-strings -Xswiftc -emit-localized-strings-path -Xswiftc "$out/data" >/dev/null
xcrun xcstringstool sync "$mac/Resources/Localizable.xcstrings" --stringsdata "$out"/data/*.stringsdata
# What's left to translate, per language.
bun -e '
  const { strings } = await Bun.file(process.argv[1]).json();
  const keys = Object.entries(strings).filter(([, s]) => s.shouldTranslate !== false && s.extractionState !== "stale");
  for (const lang of ["es", "zh-Hans", "ja", "el"]) {
    const missing = keys.filter(([, s]) => s.localizations?.[lang]?.stringUnit?.state !== "translated").map(([k]) => k);
    console.log(`${lang}: ${keys.length - missing.length}/${keys.length}` + (missing.length ? ` (missing: ${missing.slice(0, 5).join(" | ")}${missing.length > 5 ? " …" : ""})` : ""));
  }
' "$mac/Resources/Localizable.xcstrings"
