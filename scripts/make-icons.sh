#!/usr/bin/env bash
# Regenerate the PNG icons used for packaging (Linux, Android, window/dock icons) from res/.
# The source of truth is res/brain2-icon.{svg,icns,ico}; run this (on macOS) after changing them.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
iconutil -c iconset "$ROOT/res/brain2-icon.icns" -o "$TMP/icon.iconset"
mkdir -p "$ROOT/app/build/icons"
cp "$TMP/icon.iconset/icon_512x512@2x.png" "$ROOT/app/build/icon.png"
for s in 16 32 48 64 128 256 512 1024; do
  sips -z "$s" "$s" "$ROOT/app/build/icon.png" --out "$ROOT/app/build/icons/${s}x${s}.png" >/dev/null
done
rm -rf "$TMP"
echo "Icons written to app/build/"
