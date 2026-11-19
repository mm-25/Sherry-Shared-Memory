import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL(".", import.meta.url));
try {
  const { stdout } = await execFileAsync("sh", [join(root, "macos", "probe-claude.sh"), "--claude-snapshot"],
    { timeout: 30_000, maxBuffer: 5_000_000 });
  const value = JSON.parse(stdout);
  if (value.kind !== "claude_ax_snapshot_v1" || value.truncated || !Array.isArray(value.turns)) {
    throw new Error("Claude snapshot is incomplete.");
  }
  console.log(JSON.stringify({ surface: /^app:\/\/localhost\/epitaxy\/local_/.test(value.sourceURL)
    ? "claude_code" : "claude_desktop", turns: value.turns.length,
    user: value.turns.filter((turn) => turn.role === "user").length,
    assistant: value.turns.filter((turn) => turn.role === "assistant").length,
    textCharacters: value.turns.reduce((sum, turn) => sum + turn.text.length, 0) }, null, 2));
} catch (error) {
  console.error(`Claude structural verification failed: ${String(error.stderr || error.message).trim().slice(0, 300)}`);
  process.exitCode = 1;
}
