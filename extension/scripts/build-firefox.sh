#!/usr/bin/env bash
set -euo pipefail

extension_root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "JSON.parse(require('fs').readFileSync('$extension_root/manifest.json', 'utf8')).version")"
artifact_dir="$extension_root/dist"
artifact_path="$artifact_dir/sherry-capture-$version.zip"

mkdir -p "$artifact_dir"
rm -f "$artifact_path"

cd "$extension_root"
zip -X -q -r "$artifact_path" manifest.json src

echo "$artifact_path"
