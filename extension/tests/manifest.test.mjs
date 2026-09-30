import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromiumManifest } from "../scripts/build-chromium.mjs";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8")
);
const bridgeSource = await readFile(new URL("../src/sherry-bridge.js", import.meta.url), "utf8");
const backgroundSource = await readFile(new URL("../src/background.js", import.meta.url), "utf8");

test("keeps the Firefox-specific background script and Chrome service worker in source", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "src/background.js");
  assert.deepEqual(manifest.background.scripts, ["src/background.js"]);
  assert.equal(manifest.background.type, "module");
  assert.equal(
    manifest.browser_specific_settings.gecko.id,
    "shared-memory-capture@memory.local"
  );
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
  assert.equal(manifest.browser_specific_settings.gecko_android.strict_min_version, "142.0");
  assert.deepEqual(
    manifest.browser_specific_settings.gecko.data_collection_permissions,
    {
      required: [
        "personallyIdentifyingInfo",
        "healthInfo",
        "financialAndPaymentInfo",
        "authenticationInfo",
        "personalCommunications",
        "browsingActivity",
        "websiteContent"
      ],
      optional: ["technicalAndInteraction"]
    }
  );
});

test("builds a Chromium Manifest V3 with only a service worker", () => {
  const chrome = chromiumManifest(manifest);
  assert.deepEqual(chrome.background, {
    service_worker: "src/background.js",
    type: "module"
  });
  assert.equal("browser_specific_settings" in chrome, false);
  assert.deepEqual(chrome.content_scripts, manifest.content_scripts);
  assert.deepEqual(chrome.host_permissions, manifest.host_permissions);
});

test("limits optional cloud access to the authentication service", () => {
  assert.deepEqual(manifest.optional_host_permissions, [
    "https://zwpzmmfpgjaaikacoqas.supabase.co/*"
  ]);
});

test("installs the Firefox-compatible Sherry app bridge only on the production app", () => {
  assert.ok(manifest.host_permissions.includes("https://shared-memory-ingestion.mufaddal-m25.workers.dev/*"));
  const bridge = manifest.content_scripts.find((entry) => entry.js.includes("src/sherry-bridge.js"));
  assert.deepEqual(bridge.matches, ["https://shared-memory-ingestion.mufaddal-m25.workers.dev/*"]);
});

test("runtime injection uses extension-root paths instead of the popup's src directory", () => {
  assert.match(backgroundSource, /files: \["\/src\/sherry-bridge\.js"\]/);
  assert.doesNotMatch(backgroundSource, /files: \["src\/sherry-bridge\.js"\]/);
});

test("bridges Firefox page controls through a DOM mailbox with event and message fallbacks", () => {
  assert.match(bridgeSource, /sherry-capture-bridge/);
  assert.match(bridgeSource, /MutationObserver/);
  assert.match(bridgeSource, /data-sherry-request-id|sherryRequestId/);
  assert.match(bridgeSource, /sherry-capture-request/);
  assert.match(bridgeSource, /sherry-capture-response/);
  assert.match(bridgeSource, /document\.documentElement\.dataset\.sherryCaptureBridge/);
  assert.match(bridgeSource, /window\.postMessage/);
});

test("only exposes extension controls to the Memory web app and local development", () => {
  assert.deepEqual(manifest.externally_connectable.matches, [
    "https://shared-memory-ingestion.mufaddal-m25.workers.dev/*",
    "http://localhost/*",
    "http://127.0.0.1/*"
  ]);
});

test("declares every MVP provider in permissions and content scripts", () => {
  const matches = manifest.content_scripts.flatMap((entry) => entry.matches);

  for (const origin of [
    "https://chatgpt.com/*",
    "https://claude.ai/*",
    "https://gemini.google.com/*"
  ]) {
    assert.ok(manifest.host_permissions.includes(origin), `missing host permission: ${origin}`);
    assert.ok(matches.includes(origin), `missing content script: ${origin}`);
  }
});
