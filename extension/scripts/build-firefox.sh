#!/usr/bin/env bash
set -euo pipefail

extension_root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "JSON.parse(require('fs').readFileSync('$extension_root/manifest.json', 'utf8')).version")"
artifact_dir="$extension_root/dist"
artifact_path="$artifact_dir/sherry-capture-$version.zip"
package_dir="$artifact_dir/sherry-capture-firefox-$version"

mkdir -p "$package_dir"
node --input-type=module - "$extension_root" "$package_dir" <<'NODE'
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [sourceRoot, packageRoot] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(join(sourceRoot, 'manifest.json'), 'utf8'));
const overrides = JSON.parse(await readFile(join(sourceRoot, 'scripts/firefox-settings.json'), 'utf8'));
await writeFile(join(packageRoot, 'manifest.json'), JSON.stringify({ ...manifest, ...overrides }, null, 2) + '\n');
await cp(join(sourceRoot, 'src'), join(packageRoot, 'src'), { recursive: true, force: true });
NODE
rm -f "$artifact_path"

cd "$package_dir"
zip -X -q -r "$artifact_path" manifest.json src

echo "$artifact_path"
