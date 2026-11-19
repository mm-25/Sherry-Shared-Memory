(() => {
  "use strict";
  const categories = {
    web: { kind: "web", label: "Web", description: "Captured from an AI website in a browser." },
    desktop: { kind: "desktop", label: "Desktop", description: "Captured by the desktop companion, including terminal and IDE sources." },
    mobile: { kind: "mobile", label: "Mobile", description: "Captured from a mobile app." },
    unknown: { kind: "unknown", label: "Unknown source", description: "This capture does not identify its device category." }
  };
  const kinds = { web: "web", desktop: "desktop", cli: "desktop", ide: "desktop", android: "mobile", ios: "mobile" };

  function sourceCategories(conversation = {}) {
    const surfaces = [conversation.primary_surface,
      ...(Array.isArray(conversation.capture_surfaces) ? conversation.capture_surfaces : []),
      ...(Array.isArray(conversation.events) ? conversation.events.map((event) => event.surface) : [])];
    const recorded = new Set(surfaces.map((surface) => Object.hasOwn(kinds, surface) ? kinds[surface] : null).filter(Boolean));
    return recorded.size ? ["web", "desktop", "mobile"].filter((kind) => recorded.has(kind)).map((kind) => ({ ...categories[kind] }))
      : [{ ...categories.unknown }];
  }

  function speakerLabel(role, provider) {
    if (role === "user") return "You";
    if (role === "assistant") return provider || "AI";
    const labels = { unknown: "Shared excerpt", system: "System", tool: "Tool" };
    return Object.hasOwn(labels, role) ? labels[role] : "Message";
  }

  globalThis.SherryCapturePresentation = Object.freeze({ sourceCategories, speakerLabel });
})();
