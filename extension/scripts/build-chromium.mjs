import { cp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function chromiumManifest(source) {
  const manifest = structuredClone(source);
  manifest.background = {
    service_worker: source.background.service_worker,
    type: source.background.type
  };
  delete manifest.browser_specific_settings;
  return manifest;
}

export async function buildChromium() {
  const source = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(source.version)) throw new Error("Invalid extension version");
  const name = `sherry-capture-chromium-${source.version}`;
  const outputDir = join(extensionRoot, "dist", name);
  const archive = join(extensionRoot, "dist", `${name}.zip`);
  await mkdir(outputDir, { recursive: true });
  await cp(join(extensionRoot, "src"), join(outputDir, "src"), { recursive: true, force: true });
  await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(chromiumManifest(source), null, 2)}\n`);
  try { await unlink(archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const result = spawnSync("zip", ["-X", "-q", "-r", archive, "manifest.json", "src"], {
    cwd: outputDir,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(result.stderr || "Chromium package failed");
  return { outputDir, archive };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildChromium().then(({ outputDir, archive }) => {
    process.stdout.write(`${outputDir}\n${archive}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
