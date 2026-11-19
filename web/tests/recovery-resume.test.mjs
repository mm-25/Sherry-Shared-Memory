import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const helper = await readFile(new URL("../auth-session.js", import.meta.url), "utf8");
const controller = await readFile(new URL("../account-security.js", import.meta.url), "utf8");
function storage() {
  const items = new Map();
  return { items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) };
}
const cleanUrl = "https://sherry.example.test/account-security";
const freshUrl = cleanUrl + "#type=recovery&access_token=invented-recovery&refresh_token=invented-refresh";
async function page({ url = freshUrl, tab = storage(), persistent = storage(), clock = { now: 1800000000000 }, fetchImpl = async () => Response.json({ id: "invented-owner" }) } = {}) {
  const nodes = Object.fromEntries(["accountTitle", "accountDescription", "accountStatus", "recoveryEmailForm", "recoveryEmail", "sendRecovery", "newPasswordForm", "newPassword", "confirmPassword", "signOutOthers", "savePassword", "retryRecovery"].map(id => [id, { hidden: ["newPasswordForm", "retryRecovery"].includes(id), value: "", checked: false, disabled: false }]));
  const location = Object.fromEntries(["href", "hash", "search", "pathname"].map(k => [k, new URL(url)[k]]));
  const timers = [];
  class Clock extends Date { static now() { return clock.now; } }
  const context = { URL, URLSearchParams, Date: Clock, atob, fetch: fetchImpl, localStorage: persistent, sessionStorage: tab,
    document: { getElementById: id => nodes[id] }, location,
    history: { replaceState(_state, _title, path) { location.href = new URL(path, cleanUrl).href; location.hash = ""; location.search = ""; } },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, addEventListener() {} };
  vm.runInNewContext(helper, context);
  await vm.runInNewContext(controller, context);
  return { nodes, context, tab, persistent, timers, clock };
}

test("a verified recovery survives same-tab reload after URL cleanup without another email", async () => {
  const tab = storage(), persistent = storage();
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, method: opts.method }); return Response.json({ id: "invented-owner" }); };
  const first = await page({ tab, persistent, fetchImpl });
  assert.equal(first.nodes.newPasswordForm.hidden, false);
  assert.equal(first.context.location.hash, "");
  const reloaded = await page({ url: cleanUrl, tab, persistent, fetchImpl });
  assert.equal(reloaded.nodes.newPasswordForm.hidden, false, "Reload must resume the form instead of asking for another email");
  assert.equal(calls.length, 2, "Each presentation must revalidate the recovery with Supabase");
  assert.ok(calls.every(x => x.method === "GET" && x.url.endsWith("/auth/v1/user")));
  assert.equal(persistent.items.size, 0, "Recovery candidates must not enter ordinary persistent session storage");
});
test("resuming does not extend the fifteen-minute same-tab recovery window", async () => {
  const tab = storage(), clock = { now: 1800000000000 };
  await page({ tab, clock });
  clock.now += 14 * 60_000;
  assert.equal((await page({ url: cleanUrl, tab, clock })).nodes.newPasswordForm.hidden, false);
  clock.now += 2 * 60_000;
  const expired = await page({ url: cleanUrl, tab, clock, fetchImpl() { assert.fail("An expired tab candidate must not be sent"); } });
  assert.equal(expired.nodes.newPasswordForm.hidden, true);
  assert.equal(tab.items.size, 0);
});
test("definite recovery rejection removes the tab credential and cannot reappear on reload", async () => {
  const tab = storage();
  await page({ tab });
  let checks = 0;
  const invalid = await page({ url: cleanUrl, tab, fetchImpl: async () => { checks++; return Response.json({ code: "bad_jwt" }, { status: 401 }); } });
  assert.equal(checks, 1);
  assert.equal(invalid.nodes.newPasswordForm.hidden, true);
  assert.equal(tab.items.size, 0);
  await page({ url: cleanUrl, tab, fetchImpl() { assert.fail("Rejected credentials must be forgotten"); } });
});
test("an active tab clears its saved recovery at expiry without requiring a reload", async () => {
  const h = await page();
  assert.equal(h.tab.items.size, 1);
  h.clock.now += 16 * 60_000;
  h.timers[0].fn();
  assert.equal(h.tab.items.size, 0);
});
test("an expired email callback cannot silently resume an older tab candidate", async () => {
  const tab = storage();
  await page({ tab });
  const expired = await page({ url: cleanUrl + "#error=access_denied&error_code=otp_expired", tab, fetchImpl() { assert.fail("An explicit failed email callback must not use an older candidate"); } });
  assert.equal(expired.nodes.newPasswordForm.hidden, true);
  assert.equal(tab.items.size, 0);
});
test("temporary verification failure can recheck without another reset email", async () => {
  let unavailable = true;
  const calls = [];
  const h = await page({ fetchImpl: async (url, opts) => { calls.push(opts.method); return unavailable ? new Response("unavailable", { status: 503 }) : Response.json({ id: "invented-owner" }); } });
  assert.equal(h.nodes.retryRecovery.hidden, false);
  assert.equal(h.nodes.recoveryEmailForm.hidden, true, "A temporary outage must not steer the owner into sending more email");
  unavailable = false;
  await h.nodes.retryRecovery.onclick();
  assert.equal(h.nodes.newPasswordForm.hidden, false);
  assert.deepEqual(calls, ["GET", "GET"]);
});
test("blocked sessionStorage leaves a valid in-memory recovery usable", async () => {
  const tab = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); }, removeItem() { throw Error("blocked"); } };
  const h = await page({ tab });
  assert.equal(h.nodes.newPasswordForm.hidden, false);
  assert.match(h.nodes.accountStatus.textContent, /keep.*tab open/i);
});
test("confirmed password saving forgets the tab recovery and never retains password text", async () => {
  const h = await page();
  h.nodes.newPassword.value = "invented-private-password";
  h.nodes.confirmPassword.value = "invented-private-password";
  await h.nodes.newPasswordForm.onsubmit({ preventDefault() {} });
  assert.equal(h.nodes.accountTitle.textContent, "Password changed");
  assert.equal(h.tab.items.size, 0);
  assert.equal([...h.persistent.items.values()].join("").includes("invented-private-password"), false);
  assert.equal(h.nodes.newPassword.value, "");
});
test("an hourly email rejection explains the cap and honors Retry-After without retrying", async () => {
  let calls = 0;
  const h = await page({ url: cleanUrl, fetchImpl: async () => { calls++; return Response.json({ code: "over_email_send_rate_limit" }, { status: 429, headers: { "retry-after": "90" } }); } });
  h.nodes.recoveryEmail.value = "designer@example.test";
  await h.nodes.recoveryEmailForm.onsubmit({ preventDefault() {} });
  assert.equal(calls, 1);
  assert.match(h.nodes.accountStatus.textContent, /hour/i);
  assert.equal(h.nodes.sendRecovery.disabled, true);
  assert.equal(h.timers.at(-1).ms, 90_000);
  h.timers.at(-1).fn();
  assert.equal(h.nodes.sendRecovery.disabled, false);
});
test("a successful reset email request holds the resend button for the short cooldown", async () => {
  const h = await page({ url: cleanUrl });
  h.nodes.recoveryEmail.value = "designer@example.test";
  await h.nodes.recoveryEmailForm.onsubmit({ preventDefault() {} });
  assert.equal(h.nodes.sendRecovery.disabled, true);
  assert.equal(h.timers.at(-1).ms, 60_000);
});
