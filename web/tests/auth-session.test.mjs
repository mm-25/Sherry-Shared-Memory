import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const context = { URL, URLSearchParams, atob, Date };
const source = await readFile(new URL("../auth-session.js", import.meta.url), "utf8").catch((e) => { if (e.code === "ENOENT") return ""; throw e; });
vm.runInNewContext(source, context);
function setup(fetchImpl, session = { access_token: "invented-old", refresh_token: "invented-refresh", expires_at: 1 }) {
  assert.ok(context.SherryAuth, "The shared auth helper is missing");
  let stored = JSON.stringify(session);
  const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  return { client: context.SherryAuth.createClient({ fetchImpl, storage }), read: () => JSON.parse(stored), write: (value) => { stored = JSON.stringify(value); } };
}

test("expired approval credentials renew and persist the rotated session", async () => {
  const h = setup(async () => Response.json({ access_token: "invented-new", refresh_token: "invented-new-refresh", expires_at: 9999999999 }));
  assert.equal((await h.client.validSession()).access_token, "invented-new");
  assert.equal(h.read().refresh_token, "invented-new-refresh");
});
test("temporary refresh failure preserves the saved credentials", async () => {
  const h = setup(async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(h.client.refresh(), /503/);
  assert.equal(h.read().refresh_token, "invented-refresh");
});
test("refresh cannot overwrite a newer sign-in from another tab", async () => {
  let h;
  h = setup(async () => { h.write({ access_token: "invented-other-tab", refresh_token: "invented-other-refresh" }); return Response.json({ access_token: "invented-stale-result", refresh_token: "invented-stale-refresh" }); });
  assert.equal((await h.client.refresh()).access_token, "invented-other-tab");
  assert.equal(h.read().refresh_token, "invented-other-refresh");
});
test("recovery requests use the exact hosted reset destination", async () => {
  let request;
  const h = setup(async (url, options) => { request = { url, options }; return Response.json({}); });
  await h.client.requestRecovery("designer@example.test");
  const url = new URL(request.url);
  assert.equal(url.hostname, "zwpzmmfpgjaaikacoqas.supabase.co");
  assert.equal(url.pathname, "/auth/v1/recover");
  assert.equal(url.searchParams.get("redirect_to"), "https://shared-memory-ingestion.mufaddal-m25.workers.dev/account-security.html");
  assert.equal(JSON.parse(request.options.body).email, "designer@example.test");
});
test("recovery parsing requires the recovery type and hides no expiry error", () => {
  assert.ok(context.SherryAuth, "The shared auth helper is missing");
  assert.equal(context.SherryAuth.parseRecovery("https://example.test/#access_token=invented&refresh_token=invented&type=signup").kind, "none");
  assert.equal(context.SherryAuth.parseRecovery("https://example.test/#type=recovery&access_token=invented&refresh_token=invented").kind, "recovery");
  assert.equal(context.SherryAuth.parseRecovery("https://example.test/#error_code=otp_expired&error=access_denied").kind, "expired");
});
test("mismatched password confirmation sends no network request", async () => {
  const h = setup(async () => { assert.fail("A mismatched password must not be sent"); });
  await assert.rejects(h.client.changePassword({ access_token: "invented" }, "invented-password-a", "invented-password-b", true), /match/);
});
test("failed recovery validation cannot change a password", async () => {
  const calls = [];
  const h = setup(async (url, options) => { calls.push(options.method); return Response.json({ error_code: "bad_jwt" }, { status: 401 }); });
  await assert.rejects(h.client.changePassword({ access_token: "invented" }, "invented-password-a", "invented-password-a", true), /401/);
  assert.deepEqual(calls, ["GET"]);
});
test("password updates and other-session sign-out have distinct success results", async () => {
  const calls = [];
  const h = setup(async (url, options) => {
    calls.push({ url, options });
    if (options.method === "GET") return Response.json({ id: "invented-user" });
    if (options.method === "PUT") return Response.json({ id: "invented-user" });
    return new Response(null, { status: 204 });
  });
  const session = { access_token: "invented-recovery", refresh_token: "invented-recovery-refresh" };
  const result = await h.client.changePassword(session, "invented-password-a", "invented-password-a", true);
  assert.equal(result.passwordChanged, true);
  assert.equal(result.otherSessionsSignedOut, true);
  assert.equal(calls[1].url, "https://zwpzmmfpgjaaikacoqas.supabase.co/auth/v1/user");
  assert.equal(JSON.parse(calls[1].options.body).password, "invented-password-a");
  assert.equal(calls[2].url, "https://zwpzmmfpgjaaikacoqas.supabase.co/auth/v1/logout?scope=others");
  assert.equal(h.read().access_token, "invented-recovery");
  assert.equal(JSON.stringify(h.read()).includes("invented-password-a"), false);
});
test("a failed sign-out does not misreport a saved password as unchanged", async () => {
  const h = setup(async (_url, options) => options.method === "POST" ? new Response("unavailable", { status: 503 }) : Response.json({ id: "invented-user" }));
  const result = await h.client.changePassword({ access_token: "invented", refresh_token: "invented-refresh" }, "invented-password-a", "invented-password-a", true);
  assert.equal(result.passwordChanged, true);
  assert.equal(result.otherSessionsSignedOut, false);
});
test("an interrupted password update is never retried automatically", async () => {
  let writes = 0;
  const h = setup(async (_url, options) => { if (options.method === "PUT") { writes++; throw new TypeError("network interrupted"); } return Response.json({ id: "invented-user" }); });
  await assert.rejects(h.client.changePassword({ access_token: "invented" }, "invented-password-a", "invented-password-a", false), /confirm/);
  assert.equal(writes, 1);
});
test("an invalid password-update receipt does not claim success or sign out devices", async () => {
  const calls = [];
  const h = setup(async (_url, options) => { calls.push(options.method); return Response.json(options.method === "GET" ? { id: "invented-user" } : {}); });
  await assert.rejects(h.client.changePassword({ access_token: "invented" }, "invented-password-a", "invented-password-a", true), /confirm/);
  assert.deepEqual(calls, ["GET", "PUT"]);
});
test("a validation outage cannot be mistaken for an attempted password write", async () => {
  const h = setup(async () => { throw new TypeError("unreachable"); });
  await assert.rejects(h.client.changePassword({ access_token: "invented" }, "invented-password-a", "invented-password-a", true), (error) => error.uncertain === false);
});
test("a lost password response body remains an unconfirmed write without a retry", async () => {
  let writes = 0;
  const h = setup(async (_url, options) => {
    if (options.method === "GET") return Response.json({ id: "invented-user" });
    writes++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("reply interrupted")); } }));
  });
  await assert.rejects(h.client.changePassword({ access_token: "invented" }, "invented-password-a", "invented-password-a", false), (error) => error.uncertain === true);
  assert.equal(writes, 1);
});
