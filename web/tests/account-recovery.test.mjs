import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const helper = await readFile(new URL("../auth-session.js", import.meta.url), "utf8");
const controller = await readFile(new URL("../account-security.js", import.meta.url), "utf8");
const routing = await readFile(new URL("../auth-route.js", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("a recovery credential is removed from the URL before any validation request", async () => {
  const order = [];
  const nodes = Object.fromEntries(["accountTitle", "accountDescription", "accountStatus", "recoveryEmailForm", "sendRecovery", "newPasswordForm", "newPassword", "confirmPassword", "signOutOthers", "savePassword"].map((id) => [id, { hidden: id === "newPasswordForm", value: "", checked: true, disabled: false }]));
  const context = { URL, URLSearchParams, atob, Date, document: { getElementById: (id) => nodes[id] },
    location: { href: "https://sherry.example.test/account-security.html#type=recovery&access_token=invented&refresh_token=invented-refresh", hash: "#type=recovery", search: "", pathname: "/account-security.html" },
    history: { replaceState: (_state, _title, path) => { order.push("clean-url"); assert.equal(path, "/account-security.html"); } },
    localStorage: { getItem: () => null, setItem() { assert.fail("Invalid recovery must not store a session"); } },
    fetch: async () => { order.push("validate"); return new Response("invalid", { status: 401 }); } };
  vm.runInNewContext(helper, context);
  await vm.runInNewContext(controller, context);
  assert.deepEqual(order, ["clean-url", "validate"]);
  assert.equal(nodes.newPasswordForm.hidden, true);
  assert.equal(nodes.recoveryEmailForm.hidden, false);
});
test("root recovery routing preserves the credential only for its same-origin reset page", () => {
  let destination;
  const context = { URLSearchParams, location: { hash: "#type=recovery&access_token=invented", replace: (url) => { destination = url; } } };
  vm.runInNewContext(routing, context);
  assert.equal(destination, "/account-security.html#type=recovery&access_token=invented");
  assert.equal(context.SherryRecoveryRouting, true);
});
test("ordinary dashboard navigation is not mistaken for account recovery", () => {
  const context = { URLSearchParams, location: { hash: "#memory", replace() { assert.fail("Ordinary navigation must remain on the page"); } } };
  vm.runInNewContext(routing, context);
});
test("a recovery link opened into an existing Sherry page is routed on hash change", () => {
  let changed;
  let destination;
  const context = { URLSearchParams, addEventListener: (_name, fn) => { changed = fn; },
    location: { hash: "#memory", replace: (url) => { destination = url; } } };
  vm.runInNewContext(routing, context);
  assert.equal(typeof changed, "function");
  context.location.hash = "#type=recovery&access_token=invented";
  changed();
  assert.equal(destination, "/account-security.html#type=recovery&access_token=invented");
});
function appHarness(fetchImpl, storedSession) {
  let stored = JSON.stringify(storedSession);
  const context = { URL, URLSearchParams, atob, Date, fetch: fetchImpl, localStorage: { getItem: () => stored, setItem: (_key, value) => { stored = value; } } };
  vm.runInNewContext(helper, context);
  const functions = app.slice(app.indexOf("async function refreshSession("), app.indexOf("function download("));
  vm.runInNewContext(`
    const SUPABASE_URL = "https://zwpzmmfpgjaaikacoqas.supabase.co";
    const SUPABASE_KEY = "invented-publishable";
    const API_BASE = "";
    const authClient = SherryAuth.createClient({ fetchImpl: fetch, storage: localStorage });
    let session = { access_token: "invented-old", refresh_token: "invented-refresh" };
    ${functions}
    this.callApi = api;
  `, context);
  return { context, read: () => JSON.parse(stored) };
}
test("the main app does not turn a temporary renewal outage into a sign-out", async () => {
  const h = appHarness(async (url) => new Response("unavailable", { status: url.includes("grant_type") ? 503 : 401 }), { access_token: "invented-old", refresh_token: "invented-refresh" });
  await assert.rejects(h.context.callApi("/v1/conversations"), (error) => error.status === 503);
  assert.equal(h.read().refresh_token, "invented-refresh");
});
test("the main app reuses a newer recovered session instead of rotating an old one", async () => {
  const h = appHarness(async (url, options) => {
    assert.equal(url.includes("grant_type"), false, "A newer stored session must be used before renewing the old token");
    return options.headers.authorization === "Bearer invented-recovered" ? Response.json({ ok: true }) : new Response("expired", { status: 401 });
  }, { access_token: "invented-recovered", refresh_token: "invented-recovered-refresh" });
  assert.equal((await h.context.callApi("/v1/conversations")).ok, true);
});
