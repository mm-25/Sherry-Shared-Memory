#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { readCodexSession } from "./codex.js";
import { createCodexBatches } from "./batches.js";

const [command, input, output] = process.argv.slice(2);
if (!["inspect", "export"].includes(command) || !input || (command === "export" && !output)) {
  console.error("Usage: node cli.js inspect FILE | export FILE OUTPUT.json");
  process.exit(2);
}

try {
  const parsed = await readCodexSession(input);
  if (command === "inspect") {
    console.log(JSON.stringify({ sessionId: parsed.sessionId, appVersion: parsed.appVersion,
      userEvents: parsed.events.filter((event) => event.role === "user").length,
      assistantEvents: parsed.events.filter((event) => event.role === "assistant").length,
      diagnostics: parsed.diagnostics }, null, 2));
    process.exit(0);
  }
  const batches = createCodexBatches(parsed, {
    workspaceId: process.env.SHERRY_WORKSPACE_ID,
    deviceId: process.env.SHERRY_DEVICE_ID || undefined,
    surface: process.env.SHERRY_CODEX_SURFACE || "desktop",
    reason: "manual"
  });
  if (command === "export") {
    await writeFile(output, JSON.stringify(batches, null, 2), { mode: 0o600, flag: "wx" });
    console.log(`Wrote ${batches.length} Capture API v2 batch(es) to ${output}.`);
    process.exit(0);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
