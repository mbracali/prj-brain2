#!/usr/bin/env bash
# macOS: create BRAIN2.app — a tiny launcher with the BRAIN2 icon that starts the latest BRAIN2
# from this checkout (same as double-clicking BRAIN2.command). Drag it to the Dock or /Applications.
# brain2.sh runs this automatically when the launcher is missing or the icon changed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/BRAIN2.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/res/brain2-icon.icns" "$APP/Contents/Resources/brain2-icon.icns"

# The checkout path is baked in, so the launcher keeps working after being moved to /Applications.
cat > "$APP/Contents/MacOS/BRAIN2" <<SH
#!/usr/bin/env bash
ROOT=$(printf '%q' "$ROOT")
if [ ! -x "\$ROOT/brain2.sh" ]; then
  osascript -e 'display alert "BRAIN2" message "The BRAIN2 folder was moved. Run scripts/make-launcher.sh again from its new place."'
  exit 1
fi
exec "\$ROOT/brain2.sh" --detach
SH
chmod +x "$APP/Contents/MacOS/BRAIN2"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>BRAIN2</string>
  <key>CFBundleDisplayName</key><string>BRAIN2</string>
  <key>CFBundleIdentifier</key><string>app.brain2.launcher</string>
  <key>CFBundleExecutable</key><string>BRAIN2</string>
  <key>CFBundleIconFile</key><string>brain2-icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!-- The launcher only starts BRAIN2 and exits: keep it out of the Dock while it runs. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Ask Finder/Dock to pick up the (new) icon.
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
echo "Created $APP"
