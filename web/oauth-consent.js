(async () => {
  const state = document.getElementById("state");
  const allow = document.getElementById("allow");
  try {
    if (!globalThis.SherryAuth) await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/auth-session.js?v=20261028-account-recovery-1";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Sign-in support could not load. Reload this approval page."));
      document.head.append(script);
    });
    const client = globalThis.SherryAuth.createClient({ fetchImpl: fetch, storage: localStorage });
    let approving = false;
    const signIn = document.createElement("a");
    signIn.href = "/"; signIn.target = "_blank"; signIn.rel = "noopener";
    signIn.textContent = "Open Sherry to sign in";
    state.insertAdjacentElement("afterend", signIn);
    function checkSignIn() {
      if (approving) return;
      const present = Boolean(client.readSession()?.access_token);
      signIn.hidden = present;
      allow.disabled = !present;
      state.textContent = present ? "Ready. Sherry will verify your sign-in when you allow the connection."
        : "Sign in to Sherry in the other tab, then return here to allow the connection.";
    }
    checkSignIn();
    window.addEventListener("focus", checkSignIn);
    window.addEventListener("storage", (event) => { if (event.key === "memory_session") checkSignIn(); });
    allow.onclick = async () => {
      if (approving) return;
      approving = true;
      allow.disabled = true;
      state.textContent = "Connecting…";
      try {
        const before = client.readSession();
        let session = await client.validSession();
        const send = () => fetch(location.href, { method: "POST", headers: {
          authorization: `Bearer ${session.access_token}`, "content-type": "application/json"
        }, body: JSON.stringify({ csrf: document.getElementById("csrf").value }) });
        let response = await send();
        // A definite authentication rejection did not approve the connection.
        // Never repeat an ambiguous network failure or a server error.
        if (response.status === 401 && session.access_token === before?.access_token && session.refresh_token) {
          session = await client.refresh();
          response = await send();
        }
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { data = null; }
        if (response.ok && typeof data?.redirectTo === "string") {
          const target = new URL(data.redirectTo);
          if (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))) throw new Error("The connection returned an unsupported callback. Start it again from Codex.");
          location.href = target.href;
          return;
        }
        const hint = response.status === 401 ? "Your Sherry sign-in is no longer valid. Sign in again, then retry."
          : response.status === 400 ? "This approval page may have expired. Reload it or start the connection again from Codex."
          : response.status === 403 ? "This account could not approve the connection. Check its Sherry access."
          : "Sherry could not finish the connection. Please try again.";
        state.textContent = `${hint} (${response.status})`;
        if (response.status === 401) signIn.hidden = false;
      } catch (error) {
        state.textContent = error.status ? error.message : "Sherry could not confirm the connection. Check your network, then retry from Codex.";
      } finally { approving = false; allow.disabled = false; }
    };
  } catch {
    state.textContent = "Sign-in support could not load. Reload this approval page.";
    allow.disabled = true;
  }
})();
