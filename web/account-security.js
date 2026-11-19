(async () => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const client = globalThis.SherryAuth.createClient();
  const tabRecovery = globalThis.SherryAuth.recoveryTabStore();
  const retryButton = $("retryRecovery");
  globalThis.addEventListener?.("hashchange", () => { if (location.hash) location.reload(); });
  const recovery = globalThis.SherryAuth.parseRecovery(location.href);
  // Remove recovery credentials before validation or any other network request.
  if (location.hash || location.search) history.replaceState(null, "", location.pathname);
  let recoverySession = null;
  $("recoveryEmailForm").onsubmit = async (event) => {
    event.preventDefault();
    if ($("sendRecovery").disabled) return;
    $("sendRecovery").disabled = true;
    $("accountStatus").textContent = "Requesting your reset email…";
    let cooldown = 0;
    try {
      await client.requestRecovery($("recoveryEmail").value);
      cooldown = 60_000;
      $("accountStatus").textContent = "If this email belongs to a Sherry account, a reset link is on its way. Open the newest email once and finish in that tab. In Gmail, expand Show trimmed content if the body looks blank. Wait at least one minute before requesting another email.";
    } catch (error) {
      $("accountStatus").textContent = error.message;
      cooldown = error.retryAfterSeconds ? error.retryAfterSeconds * 1000
        : error.code === "over_email_send_rate_limit" ? 3_600_000 : error.status === 429 ? 60_000 : 0;
    } finally {
      if (cooldown) setTimeout(() => { $("sendRecovery").disabled = false; }, cooldown);
      else $("sendRecovery").disabled = false;
    }
  };
  $("newPasswordForm").onsubmit = async (event) => {
    event.preventDefault();
    if (!recoverySession || $("savePassword").disabled) return;
    $("savePassword").disabled = true;
    $("accountStatus").textContent = "Saving your new password…";
    try {
      const result = await client.changePassword(recoverySession, $("newPassword").value, $("confirmPassword").value, $("signOutOthers").checked);
      $("newPasswordForm").hidden = true;
      $("accountTitle").textContent = "Password changed";
      $("accountDescription").textContent = "Use your new password the next time Sherry asks you to sign in.";
      $("accountStatus").textContent = result.otherSessionsSignedOut === false
        ? "Your password changed, but Sherry could not confirm signing out other devices. Check account access before treating those devices as disconnected."
        : result.otherSessionsSignedOut === true
          ? "Your new password is saved. Other sign-in sessions have been revoked; existing access may remain until it expires."
          : "Your new password is saved.";
      if (!result.sessionSaved) $("accountStatus").textContent += " Please sign in again when you return to Sherry.";
      recoverySession = null;
      tabRecovery.clear();
    } catch (error) {
      $("accountStatus").textContent = error.uncertain
        ? "Sherry could not confirm whether your password changed. Try signing in with your new password before requesting another reset."
        : error.message;
    } finally {
      $("newPassword").value = "";
      $("confirmPassword").value = "";
      $("savePassword").disabled = false;
    }
  };
  async function openPasswordForm(candidate, canResume) {
    recoverySession = null;
    $("accountStatus").textContent = "Checking your recovery link…";
    $("recoveryEmailForm").hidden = true;
    if (retryButton) { retryButton.hidden = true; retryButton.disabled = true; }
    try {
      await client.validateRecovery(candidate);
      recoverySession = candidate;
      $("accountTitle").textContent = "Choose a new password";
      $("accountDescription").textContent = "Enter your new Sherry password below. It stays private.";
      $("accountStatus").textContent = canResume ? "" : "Please keep this tab open until you finish; this browser could not retain the recovery for a refresh.";
      $("newPasswordForm").hidden = false;
    } catch (error) {
      $("newPasswordForm").hidden = true;
      if (!error.status || error.status >= 500 || error.status === 429) {
        $("accountStatus").textContent = "Sherry temporarily could not check this recovery link. Try checking it again; you do not need another reset email.";
        if (retryButton) {
          retryButton.hidden = false;
          retryButton.disabled = false;
          retryButton.onclick = () => openPasswordForm(candidate, canResume);
        }
      } else {
        tabRecovery.clear();
        $("recoveryEmailForm").hidden = false;
        $("accountStatus").textContent = "This recovery link has expired or could not be verified. If the password form is already open in another tab, finish there. Otherwise wait for any email cooldown before requesting one new link.";
      }
    }
  }
  if (recovery.kind === "expired") {
    tabRecovery.clear();
    $("accountStatus").textContent = "This recovery link has expired or was already used. If the password form is still open in another tab, finish there. Otherwise wait for any email cooldown before requesting one new link.";
  } else if (recovery.kind === "recovery") {
    tabRecovery.clear();
    await openPasswordForm(recovery.session, tabRecovery.save(recovery.session));
  } else {
    const candidate = tabRecovery.read();
    if (candidate) await openPasswordForm(candidate, true);
  }
})();
