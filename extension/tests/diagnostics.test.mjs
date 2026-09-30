import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/diagnostics.js", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test("requests optional host permissions directly from each connection gesture", () => {
  const authHandler = sourceBetween(
    'nodes.authForm.addEventListener("submit", (event) =>',
    'nodes.createAccount.addEventListener'
  );
  const createHandler = sourceBetween(
    'nodes.createAccount.addEventListener("click", () =>',
    'nodes.syncForm.addEventListener'
  );
  const advancedHandler = sourceBetween(
    'nodes.syncForm.addEventListener("submit", (event) =>',
    'nodes.retrySync.addEventListener'
  );

  for (const handler of [authHandler, createHandler, advancedHandler]) {
    assert.match(handler, /requestConnectionPermissions\(/);
  }
});

test("does not defer permission prompts into asynchronous network helpers", () => {
  const supabaseHelper = sourceBetween(
    "async function supabaseRequest",
    "async function getOrCreateWorkspace"
  );
  const sessionHelper = sourceBetween(
    "async function connectSession",
    "async function createTestAccount"
  );

  assert.doesNotMatch(supabaseHelper, /permissions\.request|requestConnectionPermissions/);
  assert.doesNotMatch(sessionHelper, /permissions\.request|requestConnectionPermissions/);
});
