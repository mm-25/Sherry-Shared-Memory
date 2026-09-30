(() => {
  const state = document.getElementById("state");
  const allow = document.getElementById("allow");
  let session;
  try { session = JSON.parse(localStorage.getItem("memory_session") || "null"); } catch { session = null; }
  if (!session?.access_token) {
    state.textContent = "You are not signed in here. Open Memory, sign in, then return to this approval page.";
    return;
  }
  state.textContent = "You are signed in. You can approve this connection.";
  allow.disabled = false;
  allow.onclick = async () => {
    allow.disabled = true; state.textContent = "Connecting…";
    const response = await fetch(location.href, { method: "POST", headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ csrf: document.getElementById("csrf").value }) });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.redirectTo) location.href = data.redirectTo;
    else { state.textContent = data.error || (await response.text().catch(() => "Connection failed.")) || "Connection failed."; allow.disabled = false; }
  };
})();
