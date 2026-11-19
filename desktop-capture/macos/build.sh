#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .build
if [ ! -f .build/keychain_key ] || [ macos/keychain_key.c -nt .build/keychain_key ]; then
  clang -Wall -Wextra -Werror macos/keychain_key.c -o .build/keychain_key -framework Security -framework CoreFoundation
fi
# The probe is an explicit developer tool; GUI capture runs in Sherry Desktop.
if [ "${SHERRY_BUILD_AX_PROBE:-1}" != "1" ]; then exit 0; fi
probe_app=".build/Sherry Accessibility Probe.app"
probe_binary="$probe_app/Contents/MacOS/SherryAXProbe"
if [ ! -f "$probe_binary" ] || [ macos/ax_probe.c -nt "$probe_binary" ] \
    || [ macos/ax_snapshot.m -nt "$probe_binary" ] \
    || [ macos/ax_snapshot.h -nt "$probe_binary" ] \
    || [ macos/AXProbeInfo.plist -nt "$probe_binary" ]; then
  mkdir -p "$probe_app/Contents/MacOS"
  cp macos/AXProbeInfo.plist "$probe_app/Contents/Info.plist"
  clang -Wall -Wextra -Werror macos/ax_probe.c macos/ax_snapshot.m -o "$probe_binary" \
    -framework ApplicationServices -framework CoreFoundation -framework Foundation
  codesign --force --sign - --identifier com.sherry.desktop-capture.ax-probe "$probe_app"
fi
