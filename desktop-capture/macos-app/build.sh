#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SHERRY_BUILD_AX_PROBE=0 sh macos/build.sh
app=".build/Sherry Desktop.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/desktop-capture"
cp macos-app/Info.plist "$app/Contents/Info.plist"
cp macos-app/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
clang -fobjc-arc -Wall -Wextra -Werror -Wno-unused-parameter \
  macos-app/SherryDesktop.m macos/ax_snapshot.m -o "$app/Contents/MacOS/SherryDesktop" \
  -framework Cocoa -framework WebKit -framework ApplicationServices
for file in *.js package.json; do cp "$file" "$app/Contents/Resources/desktop-capture/"; done
mkdir -p "$app/Contents/Resources/backend/src" "$app/Contents/Resources/desktop-capture/macos" \
  "$app/Contents/Resources/desktop-capture/.build"
cp ../backend/src/validation.js "$app/Contents/Resources/backend/src/validation.js"
cp ../backend/src/capture-evidence.js "$app/Contents/Resources/backend/src/capture-evidence.js"
cp ../backend/src/source-metadata.js "$app/Contents/Resources/backend/src/source-metadata.js"
mkdir -p "$app/Contents/Resources/extension/src"
cp ../extension/src/upload-receipt.js "$app/Contents/Resources/extension/src/"
cp ../extension/package.json "$app/Contents/Resources/extension/package.json"
cp ../backend/package.json "$app/Contents/Resources/backend/package.json"
cp macos/probe-chatgpt.sh "$app/Contents/Resources/desktop-capture/macos/"
cp macos/probe-claude.sh "$app/Contents/Resources/desktop-capture/macos/"
# The app executable owns Accessibility capture; the standalone probe is for development only.
rm -rf "$app/Contents/Resources/desktop-capture/.build/Sherry Accessibility Probe.app"
cp .build/keychain_key "$app/Contents/Resources/desktop-capture/.build/"
mkdir -p "$app/Contents/Resources/desktop-ui"
cp macos-app/ui/* "$app/Contents/Resources/desktop-ui/"
command -v node > "$app/Contents/Resources/node-path"
node_version="$(node --version)"
runtime_marker="$app/Contents/Resources/node-runtime-version"
if [ -n "${SHERRY_RUNTIME_APP:-}" ]; then
  # Reuse a verified, identical Node runtime when disk space is too low to relink it.
  codesign --verify --deep --strict "$SHERRY_RUNTIME_APP"
  test "$("$SHERRY_RUNTIME_APP/Contents/MacOS/SherryNode" --version)" = "$node_version"
  rm -rf "$app/Contents/Frameworks"
  mkdir -p "$app/Contents/Frameworks"
  cp -c "$SHERRY_RUNTIME_APP/Contents/MacOS/SherryNode" "$app/Contents/MacOS/SherryNode"
  for library in "$SHERRY_RUNTIME_APP/Contents/Frameworks/"*.dylib; do
    cp -c "$library" "$app/Contents/Frameworks/"
  done
  printf '%s\n' "$node_version" > "$runtime_marker"
elif [ ! -x "$app/Contents/MacOS/SherryNode" ] || [ ! -f "$runtime_marker" ] \
    || [ "$(cat "$runtime_marker")" != "$node_version" ]; then
  python3 macos-app/bundle-node.py "$app" "$(command -v node)"
  printf '%s\n' "$node_version" > "$runtime_marker"
fi
# Unchanged nested runtime signatures remain valid. Sign the new helper and app explicitly.
codesign --force --sign - --identifier com.sherry.desktop "$app/Contents/Resources/desktop-capture/.build/keychain_key"
codesign --force --sign - --identifier com.sherry.desktop "$app"
"$app/Contents/MacOS/SherryNode" --input-type=module -e 'await import(process.argv[1])' \
  "$PWD/$app/Contents/Resources/backend/src/validation.js"
"$app/Contents/MacOS/SherryNode" --input-type=module -e 'await import(process.argv[1])' \
  "$PWD/$app/Contents/Resources/desktop-capture/uploader.js"
codesign --verify --deep --strict "$app"
echo "$PWD/$app"
