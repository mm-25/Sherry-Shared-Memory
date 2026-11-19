/** Capture evidence describes observations; it never upgrades them into provider facts. */
export function captureEvidenceFor(event) {
  if (event.capture_evidence?.version === 1) return event.capture_evidence;
  if (event.captureEvidence?.version === 1) return event.captureEvidence;
  const locator = String(event.source_locator || event.sourceLocator || "");
  if (/^android-(chatgpt|session):/.test(locator)) return {
    version: 1, conversationIdentity: locator.startsWith("android-session:") ? "local_session" : "local_snapshot",
    messageIdentity: "local_sequence", timestampBasis: "observed",
    orderBasis: locator.startsWith("android-session:") ? "session_sequence" : "snapshot_sequence",
    completeness: "unknown", titleBasis: "placeholder"
  };
  return null;
}

export function validateCaptureEvidence(evidence, event, capture) {
  if (evidence == null) return null;
  const fields = { version: [1], conversationIdentity: ["local_session"], messageIdentity: ["local_sequence"],
    timestampBasis: ["observed"], orderBasis: ["session_sequence"],
    completeness: ["unknown", "possibly_clipped"], titleBasis: ["placeholder", "source", "derived"] };
  if (typeof evidence !== "object" || Array.isArray(evidence) ||
      Object.keys(evidence).some(key => !Object.hasOwn(fields, key)) ||
      Object.entries(fields).some(([key, values]) => !values.includes(evidence[key]))) {
    throw new Error("must be a supported version-1 local-session evidence object");
  }
  if (capture.schemaVersion !== 2 || capture.surface !== "android" || event.messageTimestamp != null ||
      event.providerMessageId != null || !String(event.sourceLocator || "").startsWith("android-session:") ||
      event.conversationId !== event.sourceLocator) {
    throw new Error("local-session evidence requires an Android local locator and unknown provider message ID/time");
  }
  return Object.fromEntries(Object.keys(fields).map(key => [key, evidence[key]]));
}

export function observationWarnings(event) {
  const evidence = captureEvidenceFor(event);
  if (!evidence) return [];
  return ["Original message date unknown; capture time is an observation time.",
    "Conversation identity is local; do not assume a match with another device or source.",
    evidence.completeness === "possibly_clipped" ? "Message may be clipped at a screen edge." : "Full message completeness is unverified."];
}
