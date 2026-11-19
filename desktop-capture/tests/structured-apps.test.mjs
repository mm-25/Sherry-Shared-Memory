import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateCaptureBatch } from "../../backend/src/validation.js";
import { parseClaudeCodeJsonl, createClaudeCodeBatches } from "../claude-code.js";
import { collectClaudeCodeChanges } from "../claude-collector.js";
import { parseAntigravityTranscript, createAntigravityBatches } from "../antigravity.js";
import { collectAntigravityChanges } from "../antigravity-collector.js";
import { collectClaudeDesktopSnapshot } from "../claude-desktop-collector.js";
import { parseClaudeAxSnapshot, resolveClaudeDesktopIdentity } from "../claude-desktop.js";
import { uploadPending } from "../uploader.js";
import { EncryptedStateStore } from "../state.js";
import { readControls, setCapturePaused, setSourceEnabled } from "../controls.js";

const workspaceId = "f240c121-52d7-45dd-a2d3-8c4743e77955";
const sessionId = "a73cd68b-bd48-46ea-a2fe-b61238d23d09";
const when = "2026-10-01T12:00:01.000Z";
const line = (object) => JSON.stringify(object);

test("ordinary Claude chat preserves its canonical conversation ID without needing a second turn", () => {
  const snapshot = parseClaudeAxSnapshot({ kind: "claude_ax_snapshot_v1", truncated: false,
    sourceURL: `https://claude.ai/chat/${sessionId}`, title: "An ordinary desktop chat",
    turns: [{ role: "user", text: "The first ordinary chat prompt" }] });
  const state = {};
  assert.equal(snapshot.codeView, false);
  assert.equal(resolveClaudeDesktopIdentity(state, snapshot), sessionId);
  assert.equal(snapshot.title, "An ordinary desktop chat");
  assert.equal(state.claudeIdentities, undefined);
});

const claudeRows = [
  { type: "user", sessionId, uuid: "11111111-1111-4111-8111-111111111111", timestamp: when,
    message: { content: "Build this" }, version: "1.0" },
  { type: "assistant", sessionId, uuid: "22222222-2222-4222-8222-222222222222", timestamp: when,
    message: { id: "msg_answer123", content: [{ type: "thinking", thinking: "private" },
      { type: "text", text: "Working answer" }] } },
  { type: "user", sessionId, uuid: "33333333-3333-4333-8333-333333333333", timestamp: when,
    message: { content: [{ type: "tool_result", content: "tool secret" }] } },
  { type: "user", sessionId, uuid: "66666666-6666-4666-8666-666666666666", timestamp: when,
    message: { content: "<local-command-stdout>internal command result</local-command-stdout>" } },
  { type: "assistant", sessionId, uuid: "44444444-4444-4444-8444-444444444444", timestamp: when,
    message: { id: "msg_answer123", content: [{ type: "text", text: "Working answer, complete." }] } },
  { type: "assistant", sessionId, uuid: "55555555-5555-4555-8555-555555555555", timestamp: when,
    isSidechain: true, message: { id: "msg_side123", content: [{ type: "text", text: "subagent secret" }] } }
];

test("Claude Code captures visible text and stable assistant revisions, excluding tools and sidechains", () => {
  const parsed = parseClaudeCodeJsonl(claudeRows.map(line).join("\n"));
  assert.deepEqual(parsed.events.map((event) => event.role), ["user", "assistant"]);
  assert.equal(parsed.events[1].text, "Working answer, complete.");
  assert.ok(!JSON.stringify(parsed.events).includes("secret"));
  const batches = createClaudeCodeBatches(parsed, { workspaceId, deviceId: "device_test12345" });
  assert.ok(batches.every((batch) => validateCaptureBatch(batch).ok));
  assert.equal(batches[0].product, "claude_code");
});

test("Antigravity captures explicit prompts and visible planner replies only", () => {
  const rows = [
    { step_index: 1, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", created_at: when, content: "User prompt" },
    { step_index: 2, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: when,
      thinking: "private reasoning", tool_calls: [{ function: { name: "tool" } }] },
    { step_index: 3, type: "GENERIC", source: "MODEL", status: "DONE", created_at: when, content: "internal event" },
    { step_index: 4, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: when,
      content: "Visible reply" }
  ];
  const parsed = parseAntigravityTranscript(rows.map(line).join("\n"), sessionId);
  assert.deepEqual(parsed.events.map((event) => event.text), ["User prompt", "Visible reply"]);
  const batches = createAntigravityBatches(parsed, { workspaceId, deviceId: "device_test12345" });
  assert.ok(batches.every((batch) => validateCaptureBatch(batch).ok));
  assert.equal(batches[0].coverage.state, "partial");
});

test("source controls require explicit per-app opt-in and preserve pause", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "sherry-source-controls-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await setCapturePaused(home, true, when);
  await setSourceEnabled(home, "antigravity", true, "2026-10-01T12:01:00.000Z");
  const controls = await readControls(home);
  assert.equal(controls.paused, true);
  assert.equal(controls.sources.antigravity.enabled, true);
  assert.equal(controls.sources.chatgpt.enabled, false);
  assert.equal(controls.sources.antigravity.captureFrom, "2026-10-01T12:01:00.000Z");
});

test("Claude and Antigravity collectors queue encrypted v2 batches once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sherry-structured-apps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeRoot = join(root, "claude");
  const project = join(claudeRoot, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${sessionId}.jsonl`), claudeRows.map(line).join("\n"));
  const antigravityRoot = join(root, "antigravity");
  const logDir = join(antigravityRoot, sessionId, ".system_generated", "logs");
  await mkdir(logDir, { recursive: true });
  await writeFile(join(logDir, "transcript.jsonl"), [
    { step_index: 1, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", created_at: when, content: "A prompt" },
    { step_index: 2, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: when, content: "An answer" }
  ].map(line).join("\n"));
  const store = new EncryptedStateStore(join(root, "state"), randomBytes(32));
  const state = await store.load();
  const options = { workspaceId, deviceId: "device_test12345", captureFrom: "2026-10-01T12:00:00.000Z" };
  assert.equal((await collectClaudeCodeChanges(state, store, { ...options, root: claudeRoot })).addedEvents, 2);
  assert.equal((await collectAntigravityChanges(state, store, { ...options, root: antigravityRoot })).addedEvents, 2);
  assert.equal((await collectClaudeCodeChanges(state, store, { ...options, root: claudeRoot })).addedEvents, 0);
  assert.equal((await collectAntigravityChanges(state, store, { ...options, root: antigravityRoot })).addedEvents, 0);
  const bytes = await readFile(join(root, "state", "queue.json.enc"), "utf8");
  assert.ok(!bytes.includes("Working answer"));
  assert.ok(!bytes.includes("A prompt"));
  assert.equal(state.pending.length, 2);
});

test("Claude desktop skips Code view and deduplicates a desktop chat", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sherry-claude-ax-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EncryptedStateStore(root, randomBytes(32));
  const state = await store.load();
  const code = { kind: "claude_ax_snapshot_v1", sourceURL: `app://localhost/epitaxy/local_${sessionId}`,
    title: "Claude", truncated: false,
    turns: [{ role: "user", text: "Prompt" }, { role: "assistant", text: "Reply" }] };
  const options = { workspaceId, deviceId: "device_test12345" };
  assert.equal((await collectClaudeDesktopSnapshot(state, store, code, options)).codeView, true);
  assert.equal(state.pending.length, 0);
  const chat = { ...code, sourceURL: `app://localhost/chat/${sessionId}` };
  assert.equal((await collectClaudeDesktopSnapshot(state, store, chat, options)).addedEvents, 2);
  assert.equal((await collectClaudeDesktopSnapshot(state, store, chat, options)).addedEvents, 0);
  assert.ok(validateCaptureBatch(state.pending[0].batch).ok);
  assert.equal(state.pending[0].batch.product, "claude");
});

for (const source of ["claude", "antigravity"]) {
  test(`${source} first eight turns, continuation and restart preserve exact separate turns`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "sherry-native-integrity-"));
    t.after(() => rm(root,{recursive:true,force:true}));
    const store = new EncryptedStateStore(join(root,"state"),randomBytes(32));
    let state = await store.load();
    const options = {workspaceId,deviceId:"device_test12345",captureFrom:"2026-10-01T12:00:00.000Z",now:()=>when};
    const text = (i) => i%2 ? `Invented reply ${i}` : "Please repeat this intentional prompt.";
    const logDir = join(root,"brain",sessionId,".system_generated","logs");
    await mkdir(logDir,{recursive:true});
    const collect = async (count) => {
      if (source === "claude") return collectClaudeDesktopSnapshot(state,store,{
        kind:"claude_ax_snapshot_v1",sourceURL:`app://localhost/chat/${sessionId}`,title:"Invented integrity conversation",truncated:false,
        turns:Array.from({length:count},(_,i)=>({role:i%2?"assistant":"user",text:text(i)}))
      },options);
      await writeFile(join(logDir,"transcript.jsonl"),Array.from({length:count},(_,i)=>line({
        step_index:i+1,type:i%2?"PLANNER_RESPONSE":"USER_INPUT",source:i%2?"MODEL":"USER_EXPLICIT",
        status:"DONE",created_at:when,content:text(i)
      })).join("\n"));
      return collectAntigravityChanges(state,store,{...options,root:join(root,"brain")});
    };
    const cloud = new Map();
    const upload = async () => uploadPending(state,store,{endpoint:"https://example.org",accessToken:"test-token",now:()=>new Date(when),
      fetchImpl:async (_url,request)=>{
        const batch=JSON.parse(request.body);
        for (const event of batch.events) cloud.set(event.eventId,event);
        return {ok:true,status:200,json:async()=>({ok:true,batchId:batch.batchId,
          result:{status:"committed",received:batch.events.length,inserted:batch.events.length,updated:0,duplicates:0}})};
      }});
    assert.equal((await collect(8)).addedEvents,8);
    await upload();
    assert.equal(cloud.size,8);
    assert.equal((await collect(10)).addedEvents,2);
    await upload();
    state=await store.load();
    assert.equal((await collect(10)).addedEvents,0);
    assert.equal(state.pending.length,0);
    assert.equal(cloud.size,10);
    assert.deepEqual([...cloud.values()].map(({role,text})=>({role,text})),Array.from({length:10},(_,i)=>({role:i%2?"assistant":"user",text:text(i)})));
  });
}
