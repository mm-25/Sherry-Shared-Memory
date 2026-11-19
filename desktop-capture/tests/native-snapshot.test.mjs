import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createSnapshotBridge } from "../native-snapshot.js";

test("private native bridge matches concurrent replies and carries large transcripts", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const bridge = createSnapshotBridge(input, output);
  const requests = [];
  output.on("data", (data) => requests.push(JSON.parse(data)));
  const chatgpt = bridge.read("chatgpt"), claude = bridge.read("claude");
  assert.deepEqual(requests.map((r) => r.source), ["chatgpt", "claude"]);
  const large = { turns: [{ role: "assistant", text: "x".repeat(1_000_000) }] };
  const reply = JSON.stringify({ id: requests[1].id, ok: true, value: large }) + "\n";
  input.write(reply.slice(0, 70000)); input.write(reply.slice(70000));
  input.write(JSON.stringify({ id: requests[0].id, ok: false, error: "Accessibility denied" }) + "\n");
  await assert.rejects(chatgpt, /Accessibility denied/);
  assert.deepEqual(await claude, large);
  bridge.close();
});

test("native bridge handles timeout, late replies, unknown source and parent disconnect", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const bridge = createSnapshotBridge(input, output, { timeoutMs: 10 });
  await assert.rejects(bridge.read("unknown"), /Unknown capture source/);
  await assert.rejects(bridge.read("chatgpt"), /timed out/);
  input.write('{"id":1,"ok":true,"value":{}}\n');
  const pending = bridge.read("claude");
  input.end();
  await assert.rejects(pending, /connection closed/);
  await assert.rejects(bridge.read("claude"), /connection is closed/);
});
