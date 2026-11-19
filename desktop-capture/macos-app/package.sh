#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh macos-app/build.sh
stage="$(mktemp -d "${TMPDIR:-/private/tmp}/sherry-desktop-release.XXXXXX")"
trap 'rm -rf "$stage"' EXIT HUP INT TERM
ditto '.build/Sherry Desktop.app' "$stage/Sherry Desktop.app"
cp macos-app/Install.txt "$stage/Install Sherry Desktop.txt"
ln -s /Applications "$stage/Applications"
mkdir -p dist
ditto '.build/Sherry Desktop.app' 'dist/Sherry Desktop.app'
hdiutil create -volname 'Sherry Desktop' -srcfolder "$stage" -ov -format UDZO \
  'dist/Sherry-Desktop-macOS-arm64.dmg'
hdiutil verify 'dist/Sherry-Desktop-macOS-arm64.dmg'
