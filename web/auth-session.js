(() => {
  "use strict";
  const base = "https://zwpzmmfpgjaaikacoqas.supabase.co";
  const key = "sb_publishable_mEtfpCKWHYDKARfWNNO5BA_ouWQWmfN";
  const recoveryUrl = "https://shared-memory-ingestion.mufaddal-m25.workers.dev/account-security.html";
  const storageKey = "memory_session";

  function failure(status, code) {
    const descriptions = {
      weak_password: "Choose a stronger password.", same_password: "Choose a password different from the old one.",
      otp_expired: "This recovery link has expired. Request a new email.",
      over_email_send_rate_limit: "Supabase has reached the hourly email-sending limit. Wait up to one hour before requesting another reset email.",
      over_request_rate_limit: "Too many recent account requests. Pause before trying again.",
      reauthentication_needed: "Open a fresh recovery email before changing your password."
    };
    const safeCode = /^[a-z0-9_]{1,70}$/.test(code || "") ? code : "";
    const error = new Error(`${descriptions[safeCode] || "Sherry could not complete this account request."} (${status}${safeCode ? `, ${safeCode}` : ""})`);
    error.status = status;
    error.code = safeCode;
    return error;
  }

  function parseRecovery(value) {
    const params = new URL(value).hash;
    const data = new URLSearchParams(params.slice(1));
    if (data.has("error") || data.has("error_code")) return { kind: "expired" };
    if (data.get("type") !== "recovery") return { kind: "none" };
    if (!data.get("access_token") || !data.get("refresh_token")) return { kind: "expired" };
    return { kind: "recovery", session: {
      access_token: data.get("access_token"), refresh_token: data.get("refresh_token"), token_type: "bearer"
    } };
  }

  function recoveryTabStore() {
    const name = "sherry_recovery_tab_v1";
    const lifetime = 15 * 60 * 1000;
    const complete = (session) => typeof session?.access_token === "string" && session.access_token.length > 0
      && session.access_token.length <= 32768 && typeof session.refresh_token === "string"
      && session.refresh_token.length > 0 && session.refresh_token.length <= 4096;
    function clear() { try { globalThis.sessionStorage?.removeItem(name); } catch { /* Private storage may be blocked. */ } }
    function expireAt(expiresAt) {
      globalThis.setTimeout?.(() => {
        try {
          const saved = JSON.parse(globalThis.sessionStorage?.getItem(name) || "null");
          if (saved?.expiresAt <= Date.now()) clear();
        } catch { clear(); }
      }, Math.max(0, expiresAt - Date.now()));
    }
    function read() {
      try {
        const saved = JSON.parse(globalThis.sessionStorage?.getItem(name) || "null");
        if (!complete(saved?.session) || !Number.isFinite(saved.expiresAt)
          || saved.expiresAt <= Date.now() || saved.expiresAt > Date.now() + lifetime) { clear(); return null; }
        expireAt(saved.expiresAt);
        return saved.session;
      } catch { clear(); return null; }
    }
    function save(session) {
      if (!complete(session)) return false;
      try {
        const storage = globalThis.sessionStorage;
        if (!storage) return false;
        const expiresAt = Date.now() + lifetime;
        storage.setItem(name, JSON.stringify({ expiresAt,
          session: { access_token: session.access_token, refresh_token: session.refresh_token, token_type: "bearer" } }));
        expireAt(expiresAt);
        return true;
      } catch { return false; }
    }
    return { read, save, clear };
  }

  function createClient({ fetchImpl = globalThis.fetch, storage = globalThis.localStorage } = {}) {
    let refreshing = null;
    function readSession() {
      try {
        const session = JSON.parse(storage.getItem(storageKey) || "null");
        return typeof session?.access_token === "string" && session.access_token ? session : null;
      } catch { return null; }
    }
    function storeSession(session) {
      if (!session?.access_token || !session?.refresh_token) throw new Error("Sherry could not save a complete sign-in. Please sign in again.");
      storage.setItem(storageKey, JSON.stringify(session));
      return session;
    }
    async function request(path, { method = "GET", token, body } = {}) {
      let response;
      try {
        response = await fetchImpl(base + path, { method, cache: "no-store", referrerPolicy: "no-referrer", credentials: "omit",
          headers: { apikey: key, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch {
        const error = new Error("A network problem prevented Sherry from confirming this request.");
        error.uncertain = true;
        throw error;
      }
      let text;
      try { text = await response.text(); }
      catch {
        const error = new Error("Sherry could not confirm the account service response.");
        error.uncertain = true;
        throw error;
      }
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!response.ok) {
        const error = failure(response.status, data?.error_code || data?.code);
        const retryAfter = response.headers?.get("retry-after");
        const seconds = /^\d+$/.test(retryAfter || "") ? Number(retryAfter) : Math.ceil((Date.parse(retryAfter || "") - Date.now()) / 1000);
        if (seconds > 0 && seconds <= 86400) error.retryAfterSeconds = seconds;
        throw error;
      }
      return data;
    }
    function refresh() {
      if (refreshing) return refreshing;
      const run = async () => {
        const before = readSession();
        if (!before?.refresh_token) throw failure(401, "session_not_found");
        const next = await request("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: before.refresh_token } });
        const latest = readSession();
        if (latest?.access_token && latest.access_token !== before.access_token) return latest;
        return storeSession(next);
      };
      refreshing = (globalThis.navigator?.locks
        ? globalThis.navigator.locks.request("sherry-session-refresh", run) : run()).finally(() => { refreshing = null; });
      return refreshing;
    }
    async function validSession() {
      const session = readSession();
      if (!session) throw failure(401, "session_not_found");
      let expiry = Number(session.expires_at);
      if (!Number.isFinite(expiry) || expiry <= 0) {
        try {
          const encoded = session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
          expiry = Number(JSON.parse(atob(encoded)).exp);
        } catch { expiry = NaN; }
      }
      // This is only a renewal hint. Supabase still validates the credential.
      return Number.isFinite(expiry) && expiry * 1000 <= Date.now() + 60000 ? refresh() : session;
    }
    async function requestRecovery(email) {
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error("Enter your Sherry account email.");
      await request(`/auth/v1/recover?redirect_to=${encodeURIComponent(recoveryUrl)}`, { method: "POST", body: { email: email.trim() } });
    }
    async function validateRecovery(session) {
      if (!session?.access_token) throw failure(401, "session_not_found");
      const user = await request("/auth/v1/user", { token: session.access_token });
      if (!user?.id) throw failure(401, "bad_jwt");
      return user;
    }
    async function changePassword(session, password, confirmation, signOutOthers) {
      if (password !== confirmation) throw new Error("The two passwords do not match.");
      if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw new Error("Use a password between 12 and 1,024 characters.");
      let user;
      try { user = await validateRecovery(session); }
      catch (error) { error.uncertain = false; throw error; }
      const saved = await request("/auth/v1/user", { method: "PUT", token: session.access_token, body: { password } });
      if (saved?.id !== user.id) {
        const error = new Error("Sherry could not confirm the password change. Try signing in with the new password before requesting another reset.");
        error.uncertain = true;
        throw error;
      }
      const result = { passwordChanged: true, otherSessionsSignedOut: null, sessionSaved: false };
      if (signOutOthers) {
        try {
          await request("/auth/v1/logout?scope=others", { method: "POST", token: session.access_token });
          result.otherSessionsSignedOut = true;
        } catch { result.otherSessionsSignedOut = false; }
      }
      try { storeSession(session); result.sessionSaved = true; } catch { /* Password change already succeeded. */ }
      return result;
    }
    return { readSession, refresh, validSession, requestRecovery, validateRecovery, changePassword };
  }
  globalThis.SherryAuth = Object.freeze({ createClient, parseRecovery, recoveryUrl, recoveryTabStore });
})();
