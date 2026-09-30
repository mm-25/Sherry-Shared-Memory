import { upsertRetrievalPermission } from "./retrieval.js";

function esc(value) { return String(value || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
function cookie(request, name) {
  return (request.headers.get("cookie") || "").split(";").map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}
function securityHeaders(csrf) {
  return {
    "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...(csrf ? { "set-cookie": `__Host-memory_csrf=${csrf}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600` } : {})
  };
}
async function sessionUser(request, env, fetchImpl = fetch) {
  const token = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const response = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${token}` } });
  return response.ok ? response.json() : null;
}
async function service(path, env, options = {}) {
  const key = env.SUPABASE_SECRET_KEY || env.supabase_secret_key;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...options, headers: { apikey: key, authorization: `Bearer ${key}`, ...options.headers } });
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  const body = await response.text(); return body ? JSON.parse(body) : null;
}
function inferProvider(name) {
  const value = String(name || "").toLowerCase();
  for (const provider of ["chatgpt", "claude", "gemini", "grok"]) if (value.includes(provider)) return provider;
  return "generic";
}
function consentPage(query, clientName, scopes, csrf) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect to Memory</title></head><body style="font:16px system-ui;max-width:560px;margin:10vh auto;padding:24px;color:#171717"><main><p style="color:#666">Shared Memory connector</p><h1>Allow ${esc(clientName)} to use your memory?</h1><p>It is requesting: <strong>${esc(scopes.join(", ") || "memory:read")}</strong>.</p><p>Search results include only a small, source-linked context packet. The AI cannot browse your entire database.</p><p id="state">Checking your Memory sign-in…</p><input id="csrf" type="hidden" value="${esc(csrf)}"><button id="allow" disabled style="padding:12px 18px">Allow connection</button> <a href="/">Cancel</a></main><script src="/oauth-consent.js"></script></body></html>`, { headers: securityHeaders(csrf) });
}

export function createDefaultHandler(appHandler) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname !== "/authorize") return appHandler.fetch(request, env, ctx);
      const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
      if (!client) return new Response("Unknown connector client.", { status: 400 });
      if (request.method === "GET") {
        const csrf = crypto.randomUUID();
        return consentPage(url.searchParams.toString(), client.clientName || "AI provider", authRequest.scope, csrf);
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const body = await request.json().catch(() => ({}));
      if (!body.csrf || body.csrf !== cookie(request, "__Host-memory_csrf")) return new Response("Authorization check failed.", { status: 400 });
      const user = await sessionUser(request, env);
      if (!user) return new Response("Sign in to Memory before connecting.", { status: 401 });
      const workspaces = await service(`workspaces?owner_user_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`, env);
      if (!workspaces[0]) return new Response("No Memory workspace exists for this account.", { status: 403 });
      const provider = inferProvider(client.clientName);
      const granted = authRequest.scope.filter((scope) => ["memory:read", "memory:write"].includes(scope));
      if (!granted.includes("memory:read")) granted.unshift("memory:read");
      await upsertRetrievalPermission({ userId: user.id, workspaceId: workspaces[0].id, provider, clientId: client.clientId, clientName: client.clientName, readEnabled: true, writeNotesEnabled: granted.includes("memory:write") }, env);
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authRequest, userId: user.id, scope: granted,
        props: { userId: user.id, workspaceId: workspaces[0].id, provider, scopes: granted },
        metadata: { label: client.clientName || provider }
      });
      return new Response(JSON.stringify({ redirectTo }), { headers: { "content-type": "application/json", "set-cookie": "__Host-memory_csrf=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0" } });
    }
  };
}
