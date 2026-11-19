#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--delay" ]; then
  delay="${2:-}"
  case "$delay" in
    ''|*[!0-9]*) echo "--delay requires whole seconds" >&2; exit 2 ;;
  esac
  if [ "$delay" -gt 30 ]; then
    echo "--delay must be at most 30 seconds" >&2
    exit 2
  fi
  shift 2
  sleep "$delay"
fi
pid="$(ps -axo pid=,comm= | awk '$2 == "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" { print $1; exit }')"
if [ -z "$pid" ]; then
  echo "Could not find the main /Applications/ChatGPT.app process." >&2
  exit 4
fi
native="../../MacOS/SherryDesktop"
if [ "${1:-}" = "--snapshot" ] && [ -x "$native" ]; then
  exec "$native" --snapshot "$pid"
fi
probe=".build/Sherry Accessibility Probe.app/Contents/MacOS/SherryAXProbe"
sibling="../../../../Sherry Accessibility Probe.app/Contents/MacOS/SherryAXProbe"
if [ -x "$sibling" ]; then probe="$sibling"; fi
if "$probe" "$pid" "$@"; then
  exit 0
else
  probe_status=$?
fi
if [ "$probe_status" -eq 3 ]; then
  echo "When this command is run from Terminal, macOS can require Accessibility permission for Terminal itself. Enable Terminal in Privacy & Security > Accessibility, then quit/reopen Terminal and retry. Enabling only the probe may not authorize a Terminal-launched command." >&2
fi
exit "$probe_status"
