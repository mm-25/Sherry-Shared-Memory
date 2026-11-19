#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
pid="$(ps -axo pid=,comm= | awk '$2 == "/Applications/Claude.app/Contents/MacOS/Claude" { print $1; exit }')"
if [ -z "$pid" ]; then
  echo "Could not find the main /Applications/Claude.app process." >&2
  exit 4
fi
native="../../MacOS/SherryDesktop"
if [ "${1:-}" = "--claude-snapshot" ] && [ -x "$native" ]; then
  exec "$native" --claude-snapshot "$pid"
fi
probe=".build/Sherry Accessibility Probe.app/Contents/MacOS/SherryAXProbe"
sibling="../../../../Sherry Accessibility Probe.app/Contents/MacOS/SherryAXProbe"
if [ -x "$sibling" ]; then probe="$sibling"; fi
exec "$probe" "$pid" "$@"
