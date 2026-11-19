(() => {
  function routeRecovery() {
    const params = new URLSearchParams(location.hash.slice(1));
    const recoveryError = ["otp_expired", "otp_disabled", "token_expired"].includes(params.get("error_code"));
    if (params.get("type") === "recovery" || recoveryError) {
      globalThis.SherryRecoveryRouting = true;
      location.replace(`/account-security.html${location.hash}`);
    }
  }
  globalThis.addEventListener?.("hashchange", routeRecovery);
  routeRecovery();
})();
