import { mkdtemp,open,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { constants } from "node:buffer";
import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexJsonl } from "../codex.js";
import { createCodexBatches } from "../batches.js";
import { validateCaptureBatch } from "../../backend/src/validation.js";

const sessionId = "a73cd68b-bd48-46ea-a2fe-b61238d23d09";
const workspaceId = "f240c121-52d7-45dd-a2d3-8c4743e77955";
const at = "2026-10-01T12:00:00.000Z";
const row = (type, payload, timestamp = at) => JSON.stringify({ timestamp, type, payload });
const user = (id, text, kinds = ["user.text"]) => row("response_item", {
  type: "message", id, role: "user", content: [{ type: "input_text", text }],
  internal_chat_message_metadata_passthrough: { content_item_kinds: kinds }
});
const assistant = (id, text, phase = "final_answer") => row("response_item", {
  type: "message", id, role: "assistant", phase, content: [{ type: "output_text", text }]
});

test("Codex session capture excludes context, tools, developer instructions, and commentary", () => {
  const source = [
    row("session_meta", { id: sessionId, cli_version: "1.0", thread_source: "user", source: "vscode" }),
    user("context", "Internal environment", ["environments.environment_context"]),
    row("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "Secret instructions" }] }),
    user("u1", "Plan a garden"),
    assistant("progress", "I am thinking about plants", "commentary"),
    row("response_item", { type: "function_call", name: "shell" }),
    assistant("a1", "Plant lavender and thyme."),
    "{unfinished"
  ].join("\n");
  const parsed = parseCodexJsonl(source);
  assert.deepEqual(parsed.events.map(({ role, text, sequence }) => ({ role, text, sequence })), [
    { role: "user", text: "Plan a garden", sequence: 0 },
    { role: "assistant", text: "Plant lavender and thyme.", sequence: 1 }
  ]);
  assert.equal(parsed.diagnostics.skippedUserContext, 1);
  assert.equal(parsed.diagnostics.skippedAssistantPhases, 1);
  assert.equal(parsed.diagnostics.malformedRows, 1);
  assert.equal(parsed.events[0].sourceLocator, `codex:session:${sessionId}`);
});

test("Capture API v2 batches validate and replay with stable IDs", () => {
  const source = [
    row("session_meta", { id: sessionId, cli_version: "1.0", thread_source: "user", source: "vscode" }),
    user("u1", "Plan a garden"),
    assistant("a1", "Plant lavender and thyme.")
  ].join("\n");
  const parsed = parseCodexJsonl(source);
  const options = { workspaceId, deviceId: "device_test12345", capturedAt: at };
  const first = createCodexBatches(parsed, options);
  const again = createCodexBatches(parseCodexJsonl(source), options);
  assert.deepEqual(first, again);
  assert.equal(first.length, 1);
  assert.equal(first[0].captureClient.type, "structured_hook");
  assert.equal(first[0].coverage.state, "partial");
  assert.deepEqual(validateCaptureBatch(first[0]).errors, undefined);
  assert.equal(validateCaptureBatch(first[0]).ok, true);
});

test("a final answer revision keeps event identity and changes content hash", () => {
  const prefix = [row("session_meta", { id: sessionId, thread_source: "user", source: "vscode" }), user("u1", "Hello")];
  const original = parseCodexJsonl([...prefix, assistant("a1", "Hello there")].join("\n"));
  const revised = parseCodexJsonl([...prefix, assistant("a1", "Hello there, friend")].join("\n"));
  assert.equal(original.events[1].eventId, revised.events[1].eventId);
  assert.notEqual(original.events[1].contentHash, revised.events[1].contentHash);
});

test("subagent sessions are excluded even when they contain user-role rows", () => {
  const source = [
    row("session_meta", { id: sessionId, thread_source: "guardian_review", source: { subagent: { other: "guardian" } } }),
    user("u1", "Review instructions")
  ].join("\n");
  assert.throws(() => parseCodexJsonl(source), /not a verified user-owned/);
});

test("a mixed user message retains marked text without capturing attachment payloads", () => {
  const source = [
    row("session_meta", { id: sessionId, thread_source: "user", source: "vscode" }),
    row("response_item", { type: "message", id: "u1", role: "user",
      content: [{ type: "input_text", text: "Describe this image" },
        { type: "input_image", image_url: "private-image-payload" }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text", "user.image"] } })
  ].join("\n");
  const parsed = parseCodexJsonl(source);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].text, "Describe this image");
  assert.ok(!JSON.stringify(parsed).includes("private-image-payload"));
});

test("Codex streams a log larger than the string limit and preserves turns around an oversized record", async (t) => {
  const folder=await mkdtemp(join(tmpdir(),"sherry-bounded-codex-"));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const filename=join(folder,`rollout-${sessionId}.jsonl`);const file=await open(filename,"w");
  const header=row("session_meta",{id:sessionId,thread_source:"user",source:"vscode"})+"\n"+user("u1","First visible message")+"\n";
  await file.write(header,0,"utf8");
  // A sparse oversized untrusted row exercises the runtime boundary without storing private data.
  await file.write("\n"+assistant("a1","Last visible reply"),constants.MAX_STRING_LENGTH+1024,"utf8");
  await file.close();
  const moduleUrl=new URL("../codex.js",import.meta.url).href;
  const script=`import {readCodexSession} from ${JSON.stringify(moduleUrl)}; try { const p=await readCodexSession(process.argv[1]);console.log(JSON.stringify({texts:p.events.map(e=>e.text),oversizedRows:p.diagnostics.oversizedRows})); } catch(e) {console.error(e.message);process.exitCode=2;}`;
  const run=spawnSync(process.execPath,["--max-old-space-size=96","--input-type=module","-e",script,filename],{encoding:"utf8",timeout:30000,maxBuffer:4096});
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(JSON.parse(run.stdout),{texts:["First visible message","Last visible reply"],oversizedRows:1});
});

test("streaming Codex reader preserves marked user text beside a large image payload",async(t)=>{
  const folder=await mkdtemp(join(tmpdir(),"sherry-codex-image-"));t.after(()=>rm(folder,{recursive:true,force:true}));
  const filename=join(folder,`rollout-${sessionId}.jsonl`);const {writeFile}=await import("node:fs/promises");
  await writeFile(filename,[row("session_meta",{id:sessionId,thread_source:"user",source:"vscode"}),
    row("response_item",{type:"message",role:"user",content:[{type:"input_text",text:"Keep this prompt"},{type:"input_image",image_url:"x".repeat(4*1024*1024)}],internal_chat_message_metadata_passthrough:{content_item_kinds:["user.text","user.image"]}}),
    assistant("a1","Keep this reply")].join("\n"));
  const {readCodexSession}=await import("../codex.js");const parsed=await readCodexSession(filename);
  assert.deepEqual(parsed.events.map(e=>e.text),["Keep this prompt","Keep this reply"]);
  assert.equal(parsed.events[0].providerMessageId,"line:1");assert.equal(parsed.diagnostics.oversizedRows,0);
});
