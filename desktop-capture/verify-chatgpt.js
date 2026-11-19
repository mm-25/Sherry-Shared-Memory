import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseChatGptAxSnapshot } from "./chatgpt-ax.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

try {
  const { stdout } = await execFileAsync("sh", [join(here, "macos", "probe-chatgpt.sh"), "--snapshot"], {
    timeout: 30_000, maxBuffer: 5_000_000
  });
  let raw;
  try { raw = JSON.parse(stdout); }
  catch { throw new Error("ChatGPT snapshot could not be decoded."); }
  const parsed = parseChatGptAxSnapshot(raw);
  const roles = parsed.turns.reduce((counts, turn) => {
    counts[turn.role] = (counts[turn.role] || 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({ rawTurns: raw.turns.length, normalizedTurns: parsed.turns.length,
    roles, textCharacters: parsed.turns.reduce((sum, turn) => sum + turn.text.length, 0),
    emptyTurns: raw.turns.length - parsed.turns.length }));
} catch (error) {
  console.error(error.stderr ? String(error.stderr).trim().slice(0, 300)
    : "ChatGPT snapshot verification failed; no conversation text was printed.");
  process.exitCode = 1;
}
