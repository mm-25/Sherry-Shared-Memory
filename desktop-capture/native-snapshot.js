import { createInterface } from "node:readline";

// Private inherited pipes connect the service to its permission-owning GUI.
// No listening port or plaintext transcript file is created.
export function createSnapshotBridge(input, output, { timeoutMs = 30000 } = {}) {
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  const lines = createInterface({ input });
  function close() {
    if (closed) return;
    closed = true;
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("Sherry Desktop capture connection closed. Reopen Sherry Desktop."));
    }
    pending.clear();
    lines.close();
    input.pause();
  }
  lines.on("close", close);
  input.on("error", close);
  output.on("error", close);
  lines.on("line", (line) => {
    let result;
    try { result = JSON.parse(line); } catch { return close(); }
    const task = pending.get(result.id);
    if (!task) return;
    pending.delete(result.id); clearTimeout(task.timer);
    if (result.ok && result.value) task.resolve(result.value);
    else task.reject(new Error(result.error || "Native capture failed."));
  });
  return {
    close,
    read(source) {
      if (!["chatgpt", "claude"].includes(source)) return Promise.reject(new Error("Unknown capture source."));
      if (closed) return Promise.reject(new Error("Sherry Desktop capture connection is closed."));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Visible conversation read timed out. Keep the conversation open and retry."));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        output.write(JSON.stringify({ action: "snapshot", source, id }) + "\n", (error) => {
          if (!error || !pending.has(id)) return;
          clearTimeout(timer); pending.delete(id); reject(error);
        });
      });
    }
  };
}
