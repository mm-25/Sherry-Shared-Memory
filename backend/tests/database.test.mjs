import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { BATCH_ID, USER_ID, WORKSPACE_ID, validBatch, validBatchV2 } from "./fixtures.mjs";

const migrationUrls = [
  new URL("../supabase/migrations/20260914141327_gate_5_ingestion_pipeline.sql", import.meta.url),
  new URL("../supabase/migrations/20260915043914_conversation_deletion.sql", import.meta.url),
  new URL("../supabase/migrations/20260915050833_fix_event_deduplication.sql", import.meta.url),
  new URL("../supabase/migrations/20260915131614_gate_6_memory_pipeline.sql", import.meta.url),
  new URL("../supabase/migrations/20260915131908_gate_6_security_followup.sql", import.meta.url),
  new URL("../supabase/migrations/20260915132043_gate_6_checkpoint_lineage.sql", import.meta.url),
  new URL("../supabase/migrations/20260915135508_add_xai_summarizer_provider.sql", import.meta.url),
  new URL("../supabase/migrations/20260915141207_gate_6_job_execution.sql", import.meta.url),
  new URL("../supabase/migrations/20260915213348_gate_6_review_surfaces.sql", import.meta.url),
  new URL("../supabase/migrations/20260915214444_gate_6_review_actor_index.sql", import.meta.url),
  new URL("../supabase/migrations/20260915224500_atomic_summarizer_settings.sql", import.meta.url),
  new URL("../supabase/migrations/20260916040634_checkpoint_v2_quality.sql", import.meta.url),
  new URL("../supabase/migrations/20260916050023_gate_7_retrieval.sql", import.meta.url),
  new URL("../supabase/migrations/20260917192021_gate_4b_capture_v2_foundation.sql", import.meta.url),
  new URL("../supabase/migrations/20260917192850_gate_4b_capture_v2_indexes.sql", import.meta.url),
  new URL("../supabase/migrations/20260917194714_gate_4b_fallback_identity_reconciliation.sql", import.meta.url),
  new URL("../supabase/migrations/20260925141041_group_conflict_review_decisions.sql", import.meta.url),
  new URL("../supabase/migrations/20260925141915_apply_grouped_conflict_review.sql", import.meta.url),
  new URL("../supabase/migrations/20260925142154_deduplicate_future_conflict_pairs.sql", import.meta.url),
  new URL("../supabase/migrations/20260925184637_prune_false_conflicts_and_expand_review_queue.sql", import.meta.url),
  new URL("../supabase/migrations/20260925190417_prevent_superseded_claim_reactivation.sql", import.meta.url),
  new URL("../supabase/migrations/20260925234836_cross_chat_conflicts_and_time_based_summaries.sql", import.meta.url),
  new URL("../supabase/migrations/20260929120000_gate_9_delete_derived_claims.sql", import.meta.url),
  new URL("../supabase/migrations/20260930184000_gate_9_archive_conversation_index.sql", import.meta.url),
  new URL("../supabase/migrations/20261001044500_gate_9_restrict_recapture_trigger.sql", import.meta.url),
  new URL("../supabase/migrations/20261001093000_gate_9_account_deletion_jobs.sql", import.meta.url),
  new URL("../supabase/migrations/20261022000045_v1_allow_chat_recapture_after_cleanup.sql", import.meta.url),
  new URL("../supabase/migrations/20261022052449_bounded_chat_archive_cleanup.sql", import.meta.url)
];

// Legacy claim-lifecycle fixtures intentionally retain their historical schema.
// Current ingestion regressions below use every migration in chronological order.
async function migratedDatabase() {
  const names = (await readdir(new URL("../supabase/migrations/", import.meta.url))).filter((name) => name.endsWith(".sql")).sort();
  return historicalClaimsDatabase(true, names.map((name) => new URL(`../supabase/migrations/${name}`, import.meta.url)));
}

const mobileForwardMigration = new URL("../supabase/migrations/20261025211409_android_observation_evidence.sql", import.meta.url);
async function deployedBaselineWithoutMobile() {
  const names = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql") && name !== "20261002062250_mobile_capture_evidence.sql"
      && name < "20261025211409_android_observation_evidence.sql").sort();
  return historicalClaimsDatabase(true, names.map((name) => new URL(`../supabase/migrations/${name}`, import.meta.url)));
}
async function historicalClaimsDatabase(includeGate9 = true, selectedMigrations = migrationUrls) {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create schema extensions;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
  `);
  const beforeGate9 = migrationUrls.findIndex((url) => url.pathname.endsWith("20260929120000_gate_9_delete_derived_claims.sql"));
  for (const migrationUrl of includeGate9 ? selectedMigrations : migrationUrls.slice(0, beforeGate9)) {
    const migration = (await readFile(migrationUrl, "utf8"))
      // PGlite does not bundle pgcrypto; modern Postgres still provides gen_random_uuid().
      // The unmodified migration keeps the extension declaration required by Supabase.
      .replace("create extension if not exists pgcrypto with schema extensions;\n\n", "");
    await db.exec(migration);
  }
  return db;
}

test("a completed chat deletion permits a fresh capture of the same source", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id) values ($1, $2)", [WORKSPACE_ID, USER_ID]);
    const batch = validBatch();
    await db.query(`insert into public.deleted_conversations
      (workspace_id,provider,provider_conversation_id,archive_reconciled_at)
      values ($1,'chatgpt',$2,now())`, [WORKSPACE_ID, batch.events[0].conversationId]);
    await db.exec("set role service_role");
    const receipt = await callIngestion(db, batch, `${WORKSPACE_ID}/chatgpt/2026/10/21/${batch.batchId}.json`);
    assert.equal(receipt.inserted, 1);
  } finally {
    await db.close();
  }
});

test("a deletion boundary rejects stale capture work and permits its new operation", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id) values ($1, $2)", [WORKSPACE_ID, USER_ID]);
    const batch = validBatch();
    const deleted = await db.query(`insert into public.deleted_conversations
      (workspace_id,provider,provider_conversation_id,archive_reconciled_at)
      values ($1,'chatgpt',$2,now()) returning operation_id`, [WORKSPACE_ID,batch.events[0].conversationId]);
    batch.events[0]._sherryDeletionOperation = 'initial';
    await db.exec("set role service_role");
    await assert.rejects(() => callIngestion(db,batch,`${WORKSPACE_ID}/chatgpt/test/${batch.batchId}.json`), /capture_deletion_boundary_changed/);
    batch.events[0]._sherryDeletionOperation = deleted.rows[0].operation_id;
    assert.equal((await callIngestion(db,batch,`${WORKSPACE_ID}/chatgpt/test/${batch.batchId}.json`)).inserted,1);
    await db.exec("reset role");
    await db.query("delete from public.conversations where workspace_id = $1",[WORKSPACE_ID]);
    const next = await db.query(`update public.deleted_conversations set operation_id=gen_random_uuid(),
      archive_reconciled_at=null,archive_cleanup_keys=null where workspace_id=$1 returning operation_id`,[WORKSPACE_ID]);
    const replay = {...batch,batchId:'90000000-0000-4000-8000-000000000019'};
    replay.events[0]._sherryDeletionOperation=next.rows[0].operation_id;
    await db.exec("set role service_role");
    await assert.rejects(() => callIngestion(db,replay,`${WORKSPACE_ID}/chatgpt/test/${replay.batchId}.json`),/conversation_deletion_cleanup_pending/);
    await db.exec("reset role");
    await db.query("update public.deleted_conversations set archive_reconciled_at=now() where workspace_id=$1",[WORKSPACE_ID]);
    await db.exec("set role service_role");
    assert.equal((await callIngestion(db,replay,`${WORKSPACE_ID}/chatgpt/test/${replay.batchId}.json`)).inserted,1);
  } finally { await db.close(); }
});

test("account deletion creates a durable job and removes only the owner's workspace", async () => {
  const db = await historicalClaimsDatabase();
  const otherUser = "e6ab76c8-0ea7-42ed-9d23-5e4d8bd864a8";
  const otherWorkspace = "d971316b-dbbe-4aac-8178-64c221f62812";
  try {
    await db.query("insert into auth.users (id) values ($1), ($2)", [USER_ID, otherUser]);
    await db.query("insert into public.workspaces (id, owner_user_id) values ($1, $2), ($3, $4)", [WORKSPACE_ID, USER_ID, otherWorkspace, otherUser]);
    await assert.rejects(() => db.query("select public.request_account_deletion($1::uuid, $2::uuid)", [otherUser, WORKSPACE_ID]));
    await db.exec("set role authenticated");
    await assert.rejects(() => db.query("select public.request_account_deletion($1::uuid, $2::uuid)", [USER_ID, WORKSPACE_ID]));
    await db.exec("reset role");
    await db.query("select public.request_account_deletion($1::uuid, $2::uuid)", [USER_ID, WORKSPACE_ID]);
    assert.equal((await db.query("select count(*)::int as total from public.workspaces where id = $1", [WORKSPACE_ID])).rows[0].total, 0);
    assert.equal((await db.query("select count(*)::int as total from public.workspaces where id = $1", [otherWorkspace])).rows[0].total, 1);
    assert.equal((await db.query("select count(*)::int as total from public.account_deletion_jobs where workspace_id = $1", [WORKSPACE_ID])).rows[0].total, 1);
    await assert.rejects(
      () => db.query("insert into public.workspaces (owner_user_id) values ($1)", [USER_ID]),
      /account_deletion_in_progress/
    );
  } finally {
    await db.close();
  }
});

test("retirement migration preserves old claims but blocks new claims and excludes them from search", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    await db.query(`insert into public.memory_claims
      (workspace_id, predicate, value, display_text, confidence, observed_at)
      values ($1, 'legacy_preference', '"concise"'::jsonb, 'Distinctive legacy preference', 0.9, now())`, [WORKSPACE_ID]);
    await db.exec("reset role");
    const retirement = await readFile(new URL("../supabase/migrations/20260926021442_retire_claim_generation_and_search.sql", import.meta.url), "utf8");
    await db.exec(retirement);
    const stored = await db.query("select count(*)::int as total from public.memory_claims");
    assert.equal(stored.rows[0].total, 1);
    await db.exec("set role service_role");
    const results = await db.query("select result_type from public.search_memory_context($1::uuid, $2::uuid, 'Distinctive legacy preference', 12)", [USER_ID, WORKSPACE_ID]);
    assert.equal(results.rows.some((row) => row.result_type === "claim"), false);
    await assert.rejects(
      () => db.query(`insert into public.memory_claims
        (workspace_id, predicate, value, display_text, confidence, observed_at)
        values ($1, 'new_preference', '"new"'::jsonb, 'New claim', 0.9, now())`, [WORKSPACE_ID]),
      /memory claim extraction is retired/
    );
  } finally {
    await db.close();
  }
});

test("sensitivity settings migration labels existing Personal Memory and creates workspace defaults", async () => {
  const db = await historicalClaimsDatabase(false);
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.query(`insert into public.memory_notes (workspace_id, title, content, tags) values
      ($1, 'Finance', 'Budget', array['sherry:personal', 'sherry:entry', 'category:Finance']::text[]),
      ($1, 'Health', 'Allergy', array['sherry:personal', 'sherry:entry', 'category:Health']::text[]),
      ($1, 'Travel', 'Window seat', array['sherry:personal', 'sherry:entry', 'category:Travel']::text[])`, [WORKSPACE_ID]);
    const migration = await readFile(new URL("../supabase/migrations/20260930132205_gate_9_sensitivity_settings.sql", import.meta.url), "utf8");
    await db.exec(migration);
    const settings = await db.query("select financial_enabled, health_enabled, personal_enabled from public.workspace_retrieval_settings where workspace_id = $1", [WORKSPACE_ID]);
    assert.deepEqual(settings.rows[0], { financial_enabled: true, health_enabled: true, personal_enabled: true });
    const notes = await db.query("select title, tags from public.memory_notes where workspace_id = $1 order by title", [WORKSPACE_ID]);
    assert.deepEqual(notes.rows.map((row) => [row.title, row.tags.find((tag) => tag.startsWith("sensitivity:"))]), [
      ["Finance", "sensitivity:financial"], ["Health", "sensitivity:health"], ["Travel", "sensitivity:personal"]
    ]);
  } finally {
    await db.close();
  }
});

async function seedConversation(db, slug) {
  const source = await db.query(`insert into public.sources
    (workspace_id, provider, title) values ($1, 'chatgpt', 'ChatGPT')
    on conflict (workspace_id, provider, source_type) do update set title = excluded.title
    returning id`, [WORKSPACE_ID]);
  const conversation = await db.query(`insert into public.conversations
    (workspace_id, source_id, provider, provider_conversation_id, title, canonical_chat_url,
     url_observed_at, first_captured_at, last_captured_at)
    values ($1, $2, 'chatgpt', $3, $3, $4, now(), now(), now()) returning id`,
  [WORKSPACE_ID, source.rows[0].id, slug, `https://chatgpt.com/c/${slug}`]);
  return conversation.rows[0].id;
}

test("deleting a conversation removes its historical claims and conflicts", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id) values ($1, $2)", [WORKSPACE_ID, USER_ID]);
    const removedConversation = await seedConversation(db, "remove-this-chat");
    const retainedConversation = await seedConversation(db, "keep-this-chat");
    const removed = await db.query(`insert into public.memory_claims
      (workspace_id, conversation_id, predicate, value, display_text, confidence, observed_at)
      values ($1, $2, 'preference', '"one"'::jsonb, 'Private old preference', 0.8, now()) returning id`,
    [WORKSPACE_ID, removedConversation]);
    const retained = await db.query(`insert into public.memory_claims
      (workspace_id, conversation_id, predicate, value, display_text, confidence, observed_at)
      values ($1, $2, 'preference', '"two"'::jsonb, 'Other preference', 0.8, now()) returning id`,
    [WORKSPACE_ID, retainedConversation]);
    await db.query(`insert into public.memory_conflicts (workspace_id, left_claim_id, right_claim_id)
      values ($1, $2, $3) on conflict do nothing`, [WORKSPACE_ID, removed.rows[0].id, retained.rows[0].id]);
    await db.exec("set role service_role");
    await db.query("delete from public.conversations where id = $1", [removedConversation]);
    const claims = await db.query("select id from public.memory_claims where workspace_id = $1", [WORKSPACE_ID]);
    const conflicts = await db.query("select id from public.memory_conflicts where workspace_id = $1", [WORKSPACE_ID]);
    assert.deepEqual(claims.rows.map((row) => row.id), [retained.rows[0].id]);
    assert.equal(conflicts.rows.length, 0);
  } finally {
    await db.close();
  }
});

test("Gate 9 migration clears source-less legacy derived claims", async () => {
  const db = await historicalClaimsDatabase(false);
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id) values ($1, $2)", [WORKSPACE_ID, USER_ID]);
    await db.query(`insert into public.memory_claims
      (workspace_id, predicate, value, display_text, confidence, observed_at)
      values ($1, 'old_preference', '"private"'::jsonb, 'Orphaned derived text', 0.8, now())`, [WORKSPACE_ID]);
    await db.exec(await readFile(new URL("../supabase/migrations/20260929120000_gate_9_delete_derived_claims.sql", import.meta.url), "utf8"));
    const claims = await db.query("select count(*)::int as total from public.memory_claims where conversation_id is null and authority = 'derived'");
    assert.equal(claims.rows[0].total, 0);
  } finally {
    await db.close();
  }
});

async function callIngestion(db, batch, rawObjectKey, sha256 = "a".repeat(64)) {
  const result = await db.query(
    `select public.ingest_capture_batch(
      $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
      $7::text, $8::bigint, $9::jsonb, $10::jsonb
    ) as result`,
    [
      USER_ID,
      WORKSPACE_ID,
      batch.batchId,
      batch.provider,
      batch.reason,
      rawObjectKey,
      sha256,
      JSON.stringify(batch).length,
      JSON.stringify({ total: 0, byType: {}, events: [] }),
      JSON.stringify(batch.events)
    ]
  );
  return result.rows[0].result;
}

async function callIngestionV2(db, batch, rawObjectKey, sha256 = "c".repeat(64), rpc = "ingest_capture_batch_v2") {
  const result = await db.query(
    `select public.${rpc}(
      $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
      $7::text, $8::text, $9::text, $10::text, $11::bigint, $12::jsonb,
      $13::jsonb, $14::jsonb, $15::jsonb
    ) as result`,
    [
      USER_ID,
      WORKSPACE_ID,
      batch.batchId,
      batch.provider,
      batch.providerFamily,
      batch.product,
      batch.surface,
      batch.reason,
      rawObjectKey,
      sha256,
      JSON.stringify(batch).length,
      JSON.stringify({ total: 0, byType: {}, events: [] }),
      JSON.stringify(batch.captureClient),
      JSON.stringify(batch.coverage),
      JSON.stringify(batch.events)
    ]
  );
  return result.rows[0].result;
}

test("current phone-local identity stays separate from an overlapping browser conversation", async () => {
  const db = await migratedDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id) values ($1, $2)", [WORKSPACE_ID, USER_ID]);
    const browser = validBatchV2();
    const phone = structuredClone(browser);
    phone.batchId = "90000000-0000-4000-8000-000000000028";
    phone.surface = "android";
    phone.reason = "accessibility";
    Object.assign(phone.captureClient, { type: "accessibility", os: "android", deviceId: "device:phone-test" });
    Object.assign(phone.events[0], {
      eventId: "evt_phone_overlap", conversationId: "android-session:separate-phone-context",
      sourceLocator: "android-session:separate-phone-context", sourceUrl: null, providerMessageId: null,
      chatTitle: "ChatGPT captured conversation",
      captureEvidence: { version: 1, conversationIdentity: "local_session", messageIdentity: "local_sequence",
        timestampBasis: "observed", orderBasis: "session_sequence", completeness: "unknown", titleBasis: "placeholder" }
    });
    await db.exec("set role service_role");
    assert.equal((await callIngestionV2(db, browser, `${WORKSPACE_ID}/chatgpt/test/${browser.batchId}.json`)).inserted, 1);
    const rpc = "ingest_capture_batch_v2_evidence";
    assert.equal((await callIngestionV2(db, phone, `${WORKSPACE_ID}/chatgpt/test/${phone.batchId}.json`, "b".repeat(64), rpc)).inserted, 1);
    assert.equal((await callIngestionV2(db, phone, `${WORKSPACE_ID}/chatgpt/test/${phone.batchId}.json`, "b".repeat(64), rpc)).idempotentReplay, true);
    const rows = (await db.query("select provider_conversation_id, count(*)::int as events from public.conversation_events group by provider_conversation_id order by provider_conversation_id")).rows;
    assert.equal((await db.query("select count(*)::int as count from public.conversations")).rows[0].count, 2);
    assert.deepEqual(rows.map((row) => row.events), [1, 1]);
    assert.deepEqual(rows.map((row) => row.provider_conversation_id), [phone.events[0].conversationId, browser.events[0].conversationId]);
  } finally { await db.close(); }
});

test("cloud reconciliation can reuse a proven shared provider chat and message identity across surfaces", async () => {
  const db = await migratedDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id) values ($1, $2)", [WORKSPACE_ID, USER_ID]);
    const browser = validBatchV2();
    // This is a cloud capability test. The current Android reader does not
    // expose the provider IDs required to produce this future payload.
    const continued = structuredClone(browser);
    continued.batchId = "90000000-0000-4000-8000-000000000029";
    continued.surface = "android";
    continued.reason = "accessibility";
    Object.assign(continued.captureClient, { type: "accessibility", os: "android", deviceId: "device:phone-shared-id-test" });
    continued.events[0].eventId = "evt_same_provider_turn_from_phone";
    continued.events.push({ ...continued.events[0], eventId: "evt_new_provider_turn_from_phone",
      providerMessageId: "message-124", sequence: 1, role: "assistant", text: "An invented continued reply.", contentHash: "cd56ef78" });
    await db.exec("set role service_role");
    assert.equal((await callIngestionV2(db, browser, `${WORKSPACE_ID}/chatgpt/test/${browser.batchId}.json`)).inserted, 1);
    const receipt = await callIngestionV2(db, continued, `${WORKSPACE_ID}/chatgpt/test/${continued.batchId}.json`, "d".repeat(64));
    assert.equal(receipt.inserted, 1);
    assert.equal(receipt.duplicates, 1);
    assert.equal((await db.query("select count(*)::int as count from public.conversations")).rows[0].count, 1);
    const turns = (await db.query("select provider_message_id, sequence, role from public.conversation_events order by sequence")).rows;
    assert.deepEqual(turns.map((row) => row.provider_message_id), ["message-123", "message-124"]);
    assert.deepEqual(turns.map((row) => row.role), ["user", "assistant"]);
  } finally { await db.close(); }
});

test("activity rollup ignores a later positional recapture of the same message", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.exec(await readFile(new URL("../supabase/migrations/20260927125621_stable_conversation_activity.sql", import.meta.url), "utf8"));
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    const text = "A long Gemini message with an identical role and text, rediscovered at another on-screen position.";
    const original = validBatchV2({
      provider: "chatgpt",
      events: [{ ...validBatchV2().events[0], eventId: "original", providerMessageId: null, role: "assistant", text, sequence: 30, capturedAt: "2026-09-24T12:00:00Z" }]
    });
    await callIngestionV2(db, original, `${WORKSPACE_ID}/chatgpt/2026/09/24/${original.batchId}.json`);
    const replay = { ...original, batchId: "90000000-0000-4000-8000-000000000001", events: [{ ...original.events[0], eventId: "repeat", sequence: 14, capturedAt: "2026-09-27T12:00:00Z" }] };
    await callIngestionV2(db, replay, `${WORKSPACE_ID}/chatgpt/2026/09/27/${replay.batchId}.json`, "d".repeat(64));
    const rollup = await db.query("select first_new_content_at, source_message_at from public.conversation_activity_rollup($1::uuid)", [WORKSPACE_ID]);
    assert.equal(rollup.rows.length, 1);
    assert.equal(new Date(rollup.rows[0].first_new_content_at).toISOString(), "2026-09-24T12:00:00.000Z");
    assert.equal(rollup.rows[0].source_message_at, null);
  } finally {
    await db.close();
  }
});

test("migration executes and ingestion atomically creates searchable events and a cursor", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");

    const batch = validBatch();
    const key = `${WORKSPACE_ID}/chatgpt/2026/09/14/${BATCH_ID}.json`;
    const result = await callIngestion(db, batch, key);
    assert.deepEqual(result, {
      idempotentReplay: false,
      status: "committed",
      received: 1,
      inserted: 1,
      updated: 0,
      duplicates: 0
    });

    await db.exec("reset role");
    const counts = await db.query(`
      select
        (select count(*)::int from public.conversation_events) as events,
        (select count(*)::int from public.text_chunks) as chunks,
        (select count(*)::int from public.sync_cursors) as cursors,
        (select count(*)::int from public.diagnostic_events) as diagnostics
    `);
    assert.deepEqual(counts.rows[0], { events: 1, chunks: 1, cursors: 1, diagnostics: 1 });

    const search = await db.query("select count(*)::int as matches from public.text_chunks where search_vector @@ websearch_to_tsquery('simple', 'concise design')");
    assert.equal(search.rows[0].matches, 1);
  } finally {
    await db.close();
  }
});

test("archive index migration leaves legacy duplicate-only batches discoverable", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    const first = validBatch();
    await callIngestion(db, first, `${WORKSPACE_ID}/chatgpt/2026/09/30/${first.batchId}.json`);
    const duplicate = { ...first, batchId: "90000000-0000-4000-8000-000000000009" };
    const receipt = await callIngestion(db, duplicate, `${WORKSPACE_ID}/chatgpt/2026/09/30/${duplicate.batchId}.json`, "b".repeat(64));
    assert.equal(receipt.duplicates, 1);
    await db.exec("reset role");
    await db.exec(await readFile(new URL("../supabase/migrations/20260930184000_gate_9_archive_conversation_index.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../supabase/migrations/20261001044500_gate_9_restrict_recapture_trigger.sql", import.meta.url), "utf8"));
    const permissions = await db.query(`select
      has_function_privilege('anon', 'public.reject_recapture_of_deleted_conversation()', 'EXECUTE') as anonymous_can_call,
      has_function_privilege('authenticated', 'public.reject_recapture_of_deleted_conversation()', 'EXECUTE') as signed_in_can_call`);
    assert.deepEqual(permissions.rows[0], { anonymous_can_call: false, signed_in_can_call: false });
    const rows = await db.query("select batch_id, provider_conversation_ids from public.ingestion_batches order by id");
    assert.deepEqual(rows.rows.map((row) => row.provider_conversation_ids), [[first.events[0].conversationId], null]);
    await db.query("insert into public.deleted_conversations (workspace_id, provider, provider_conversation_id) values ($1, 'chatgpt', $2)", [WORKSPACE_ID, first.events[0].conversationId]);
    await db.exec("set role service_role");
    const late = { ...first, batchId: "90000000-0000-4000-8000-000000000010" };
    await assert.rejects(
      () => callIngestion(db, late, `${WORKSPACE_ID}/chatgpt/2026/09/30/${late.batchId}.json`, "c".repeat(64)),
      /deleted_conversation_recapture_blocked/
    );
  } finally {
    await db.close();
  }
});

test("database transaction treats identical batches as replays and changed stream content as a revision", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    const first = validBatch();
    const firstKey = `${WORKSPACE_ID}/chatgpt/2026/09/14/${BATCH_ID}.json`;
    await callIngestion(db, first, firstKey);
    const replay = await callIngestion(db, first, firstKey);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.inserted, 1);

    const changed = validBatch({ batchId: "8453ae63-3211-468c-8852-dd159c22a31f" });
    changed.events[0].text = "Remember that I prefer detailed design reviews.";
    changed.events[0].contentHash = "98fe76dc";
    changed.events[0].capturedAt = "2026-09-14T14:01:00.000Z";
    const changedKey = `${WORKSPACE_ID}/chatgpt/2026/09/14/${changed.batchId}.json`;
    const updated = await callIngestion(db, changed, changedKey, "b".repeat(64));
    assert.equal(updated.updated, 1);

    await db.exec("reset role");
    const event = await db.query("select text_content, revision from public.conversation_events");
    assert.deepEqual(event.rows[0], {
      text_content: "Remember that I prefer detailed design reviews.",
      revision: 2
    });
  } finally {
    await db.close();
  }
});

test("one conflict choice resolves repeated statement pairs and retires superseded claims", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    await db.exec("reset role");
    const firstChat = await seedConversation(db, "first");
    const secondChat = await seedConversation(db, "second");
    const thirdChat = await seedConversation(db, "third");
    await db.exec("set role service_role");
    const insertClaim = async (value, text, conversationId) => {
      const result = await db.query(`insert into public.memory_claims
        (workspace_id, conversation_id, predicate, value, display_text, confidence, observed_at)
        values ($1, $2, 'project_context', $3::jsonb, $4, 0.9, now()) returning id`,
      [WORKSPACE_ID, conversationId, JSON.stringify(value), text]);
      return result.rows[0].id;
    };
    const left = [await insertClaim("earlier", "The user calls the project Memory", firstChat), await insertClaim("earlier", "The user calls the project Memory", firstChat)];
    const right = [await insertClaim("newer", "The user calls the project Sherry", secondChat), await insertClaim("newer", "The user calls the project Sherry", secondChat)];
    const third = await insertClaim("third", "The user calls the project something else", thirdChat);

    const newConflictCount = await db.query("select count(*)::int as total from public.memory_conflicts");
    assert.equal(newConflictCount.rows[0].total, 3, "new inserts create one conflict per distinct visible pair");
    // Seed legacy pairwise duplicates to verify existing queues are handled too.
    for (const [older, newer] of [
      ...left.flatMap((leftId) => right.map((rightId) => [leftId, rightId])),
      ...left.map((leftId) => [leftId, third]),
      ...right.map((rightId) => [rightId, third])
    ]) {
      await db.query(`insert into public.memory_conflicts (workspace_id, left_claim_id, right_claim_id)
        values ($1, $2, $3) on conflict do nothing`, [WORKSPACE_ID, older, newer]);
    }

    const before = await db.query("select public.list_review_conflicts($1::uuid, 100) as result", [WORKSPACE_ID]);
    assert.equal(before.rows[0].result.total, 3);
    assert.ok(before.rows[0].result.items.some((item) => item.repeated_count === 4));

    const pair = await db.query(`select id from public.memory_conflicts
      where left_claim_id = $1 and right_claim_id = $2`, [left[0], right[0]]);
    const decision = await db.query(`select public.resolve_memory_conflict(
      $1::uuid, $2::uuid, 'keep_left', $3::uuid) as result`, [WORKSPACE_ID, pair.rows[0].id, USER_ID]);
    assert.equal(decision.rows[0].result.affectedClaims, 4);
    assert.equal(decision.rows[0].result.affectedConflicts, 6);

    const statuses = await db.query(`select status, count(*)::int as total from public.memory_claims
      where id = any($1::uuid[]) or id = any($2::uuid[]) group by status`, [left, right]);
    assert.deepEqual(Object.fromEntries(statuses.rows.map((row) => [row.status, row.total])), { confirmed: 2, superseded: 2 });
    await assert.rejects(() => db.query(`select public.review_memory_claim(
      $1::uuid, $2::uuid, 'yes', $3::uuid)`, [WORKSPACE_ID, right[0], USER_ID]), /memory_claim_no_longer_reviewable/);
    const after = await db.query("select public.list_review_conflicts($1::uuid, 100) as result", [WORKSPACE_ID]);
    assert.equal(after.rows[0].result.total, 1);
    assert.equal(after.rows[0].result.items[0].repeated_count, 2);
    const reviews = await db.query("select count(*)::int as total from public.memory_claim_reviews");
    assert.equal(reviews.rows[0].total, 4);
    const replay = await db.query(`select public.resolve_memory_conflict(
      $1::uuid, $2::uuid, 'keep_left', $3::uuid) as result`, [WORKSPACE_ID, pair.rows[0].id, USER_ID]);
    assert.equal(replay.rows[0].result.idempotentReplay, true);
    const reviewsAfterReplay = await db.query("select count(*)::int as total from public.memory_claim_reviews");
    assert.equal(reviewsAfterReplay.rows[0].total, 4);
  } finally {
    await db.close();
  }
});

test("identical displayed statements never require a choice, even with different JSON values", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    const ids = [];
    for (const value of ["short", "concise"]) {
      const saved = await db.query(`insert into public.memory_claims
        (workspace_id, predicate, value, display_text, confidence, observed_at)
        values ($1, 'response_style', $2::jsonb, 'User prefers concise replies', 0.9, now()) returning id`,
      [WORKSPACE_ID, JSON.stringify(value)]);
      ids.push(saved.rows[0].id);
    }
    const generated = await db.query("select count(*)::int as total from public.memory_conflicts");
    assert.equal(generated.rows[0].total, 0);
    await db.query(`insert into public.memory_conflicts (workspace_id, left_claim_id, right_claim_id)
      values ($1, $2, $3)`, [WORKSPACE_ID, ...ids]);
    const before = await db.query("select public.list_review_conflicts($1::uuid, 2000) as result", [WORKSPACE_ID]);
    assert.equal(before.rows[0].result.total, 0, "historical false conflicts are hidden before cleanup");
    await db.exec("reset role");
    const cleanup = await readFile(new URL("../supabase/migrations/20260925184637_prune_false_conflicts_and_expand_review_queue.sql", import.meta.url), "utf8");
    await db.exec(cleanup);
    const row = await db.query("select status, resolution from public.memory_conflicts");
    assert.deepEqual(row.rows[0], { status: "dismissed", resolution: "same_statement" });
    const claims = await db.query("select status from public.memory_claims");
    assert.deepEqual(claims.rows.map((claim) => claim.status), ["provisional", "provisional"]);
  } finally {
    await db.close();
  }
});

test("summary revisions within one chat stay saved but never enter the conflict queue", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    await db.exec("reset role");
    const chat = await seedConversation(db, "revised-chat");
    await db.exec("set role service_role");
    const ids = [];
    for (const [value, text] of [["concise", "The user prefers concise slides"], ["visual", "The user prefers visual slides"]]) {
      const saved = await db.query(`insert into public.memory_claims
        (workspace_id, conversation_id, predicate, value, display_text, confidence, observed_at)
        values ($1, $2, 'slide_preference', $3::jsonb, $4, 0.9, now()) returning id`,
      [WORKSPACE_ID, chat, JSON.stringify(value), text]);
      ids.push(saved.rows[0].id);
    }
    const generated = await db.query("select count(*)::int as total from public.memory_conflicts");
    assert.equal(generated.rows[0].total, 0);
    await db.query(`insert into public.memory_conflicts (workspace_id, left_claim_id, right_claim_id)
      values ($1, $2, $3)`, [WORKSPACE_ID, ...ids]);
    const queue = await db.query("select public.list_review_conflicts($1::uuid, 2000) as result", [WORKSPACE_ID]);
    assert.equal(queue.rows[0].result.total, 0);
    await db.exec("reset role");
    await db.exec(await readFile(new URL("../supabase/migrations/20260925234836_cross_chat_conflicts_and_time_based_summaries.sql", import.meta.url), "utf8"));
    const row = await db.query("select status, resolution from public.memory_conflicts");
    assert.deepEqual(row.rows[0], { status: "dismissed", resolution: "same_conversation" });
    const claims = await db.query("select count(*)::int as total from public.memory_claims where status = 'provisional'");
    assert.equal(claims.rows[0].total, 2);
  } finally {
    await db.close();
  }
});

test("database rejects a valid user writing to a workspace they do not own", async () => {
  const db = await historicalClaimsDatabase();
  try {
    const otherUser = "5a59e218-44dc-4875-9e5e-10916c3a8ce4";
    await db.query("insert into auth.users (id) values ($1), ($2)", [USER_ID, otherUser]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Other Memory')", [WORKSPACE_ID, otherUser]);
    await db.exec("set role service_role");
    const batch = validBatch();
    const key = `${WORKSPACE_ID}/chatgpt/2026/09/14/${BATCH_ID}.json`;
    await assert.rejects(() => callIngestion(db, batch, key), /workspace_not_owned/);
  } finally {
    await db.close();
  }
});

test("distinct event identities survive repeated provider sequence positions", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    const batch = validBatch();
    const second = { ...batch.events[0], eventId: "evt_distinct", providerMessageId: null, text: "A separate message at the same observed position.", contentHash: "9988aabb" };
    batch.events.push(second);
    const key = `${WORKSPACE_ID}/chatgpt/2026/09/14/${BATCH_ID}.json`;
    const result = await callIngestion(db, batch, key);
    assert.equal(result.inserted, 2);
    await db.exec("reset role");
    const count = await db.query("select count(*)::int as count from public.conversation_events");
    assert.equal(count.rows[0].count, 2);
  } finally {
    await db.close();
  }
});

test("Capture API v2 persists device, adapter, source locator, and coverage provenance", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    const batch = validBatchV2();
    const key = `${WORKSPACE_ID}/chatgpt/2026/09/14/${BATCH_ID}.json`;
    const result = await callIngestionV2(db, batch, key);
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.coverageState, "complete_observed_range");

    await db.exec("reset role");
    const provenance = await db.query(`
      select
        (select count(*)::int from public.devices) as devices,
        (select count(*)::int from public.capture_adapters) as adapters,
        (select schema_version from public.ingestion_batches limit 1) as schema_version,
        (select provider_family from public.ingestion_batches limit 1) as provider_family,
        (select product from public.ingestion_batches limit 1) as product,
        (select surface from public.ingestion_batches limit 1) as surface,
        (select source_locator from public.conversation_events limit 1) as source_locator,
        (select coverage_state from public.conversations limit 1) as coverage_state
    `);
    assert.deepEqual(provenance.rows[0], {
      devices: 1,
      adapters: 1,
      schema_version: 2,
      provider_family: "openai",
      product: "chatgpt",
      surface: "web",
      source_locator: "web:chatgpt:conversation-123",
      coverage_state: "complete_observed_range"
    });
  } finally {
    await db.close();
  }
});

test("Capture API v2 never replaces a different identity solely at the same position", async () => {
  const db = await migratedDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id) values ($1, $2)", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    const first = validBatchV2();
    first.events[0].providerMessageId = null;
    await callIngestionV2(db, first, `${WORKSPACE_ID}/chatgpt/2026/10/24/${first.batchId}.json`);
    const second = validBatchV2({ batchId: "8453ae63-3211-468c-8852-dd159c22a31f" });
    Object.assign(second.events[0], { eventId: "evt_different_turn", providerMessageId: null,
      text: "A different message on a partly loaded page.", contentHash: "9988aabb" });
    assert.equal((await callIngestionV2(db, second, `${WORKSPACE_ID}/chatgpt/2026/10/24/${second.batchId}.json`, "d".repeat(64))).inserted, 1);
    // Replaying an existing identity changes neither the count nor the first turn.
    const replay = validBatchV2({ ...second, batchId: "8453ae63-3211-468c-8852-dd159c22a320" });
    assert.equal((await callIngestionV2(db, replay, `${WORKSPACE_ID}/chatgpt/2026/10/24/${replay.batchId}.json`, "e".repeat(64))).duplicates, 1);
    await db.exec("reset role");
    const events = await db.query("select event_key, text_content as text from public.conversation_events order by id");
    assert.deepEqual(events.rows, [
      { event_key: first.events[0].eventId, text: first.events[0].text },
      { event_key: second.events[0].eventId, text: second.events[0].text }
    ]);
  } finally { await db.close(); }
});

test("Gate 7 search ranks exact source excerpts and isolates workspaces", async () => {
  const db = await historicalClaimsDatabase();
  try {
    const otherUser = "5a59e218-44dc-4875-9e5e-10916c3a8ce4";
    await db.query("insert into auth.users (id) values ($1), ($2)", [USER_ID, otherUser]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    await callIngestion(db, validBatch(), `${WORKSPACE_ID}/chatgpt/2026/09/14/${BATCH_ID}.json`);
    const found = await db.query("select * from public.search_memory_context($1, $2, 'What kind of design feedback and project updates does the user prefer?', 12)", [USER_ID, WORKSPACE_ID]);
    assert.equal(found.rows[0].result_type, "excerpt");
    assert.match(found.rows[0].content, /concise design reviews/i);
    const denied = await db.query("select * from public.search_memory_context($1, $2, 'What kind of design feedback and project updates does the user prefer?', 12)", [otherUser, WORKSPACE_ID]);
    assert.equal(denied.rows.length, 0);
  } finally {
    await db.close();
  }
});

test("Gate 6 settings use safe defaults and keep encrypted credentials server-only", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.query("insert into public.summarizer_settings (workspace_id) values ($1)", [WORKSPACE_ID]);

    const settings = await db.query(`
      select enabled, interval_minutes, min_new_events,
             max_single_event_wait_minutes, continuity_overlap_events,
             provider, api_key_configured
      from public.summarizer_settings
      where workspace_id = $1
    `, [WORKSPACE_ID]);
    assert.deepEqual(settings.rows[0], {
      enabled: true,
      interval_minutes: 10,
      min_new_events: 2,
      max_single_event_wait_minutes: 30,
      continuity_overlap_events: 2,
      provider: "anthropic",
      api_key_configured: false
    });

    await assert.rejects(
      () => db.query("update public.summarizer_settings set interval_minutes = 7 where workspace_id = $1", [WORKSPACE_ID]),
      /summarizer_settings_interval_allowed/
    );

    await db.query("update public.summarizer_settings set provider = 'xai' where workspace_id = $1", [WORKSPACE_ID]);
    const grok = await db.query("select provider from public.summarizer_settings where workspace_id = $1", [WORKSPACE_ID]);
    assert.equal(grok.rows[0].provider, "xai");

    await db.exec("set role authenticated");
    await db.exec(`set request.jwt.claim.sub = '${USER_ID}'`);
    await assert.rejects(
      () => db.query("select * from public.summarizer_secrets"),
      /permission denied/
    );
  } finally {
    await db.close();
  }
});

test("summarizer settings and encrypted credentials save atomically", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");

    const parameters = [
      WORKSPACE_ID, USER_ID, true, 10, 2, 30, 2,
      "anthropic", "claude-test-model", "checkpoint-v1", "upsert",
      "encrypted-ciphertext-material", "initialization-vector", 1,
      "ending in 1234", "2026-09-15T22:45:00.000Z"
    ];
    const call = `select public.save_summarizer_configuration(
      $1::uuid, $2::uuid, $3::boolean, $4::integer, $5::integer, $6::integer,
      $7::integer, $8::text, $9::text, $10::text, $11::text, $12::text,
      $13::text, $14::integer, $15::text, $16::timestamptz
    ) as result`;

    const saved = await db.query(call, parameters);
    assert.equal(saved.rows[0].result.api_key_configured, true);
    assert.equal((await db.query("select count(*)::int as count from public.summarizer_secrets")).rows[0].count, 1);

    await assert.rejects(
      () => db.query(call, [...parameters.slice(0, 3), 7, ...parameters.slice(4)]),
      /summarizer_settings_interval_allowed/
    );
    const persisted = await db.query("select interval_minutes from public.summarizer_settings where workspace_id = $1", [WORKSPACE_ID]);
    assert.equal(persisted.rows[0].interval_minutes, 10);
  } finally {
    await db.close();
  }
});

test("Gate 6 job functions claim once and atomically persist checkpoint, claims, evidence, and usage", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id, name) values ($1, $2, 'Test Memory')", [WORKSPACE_ID, USER_ID]);
    await db.exec("set role service_role");
    const batch = validBatch();
    const key = `${WORKSPACE_ID}/chatgpt/2026/09/14/${BATCH_ID}.json`;
    await callIngestion(db, batch, key);
    const source = await db.query("select conversation_id, id, revision from public.conversation_events limit 1");
    const eventId = String(source.rows[0].id);
    const conversationId = source.rows[0].conversation_id;

    const queued = await db.query(
      `select public.enqueue_summarization_job(
        $1::uuid, $2::uuid, 'manual', $3::bigint[], '{}'::bigint[], $4::jsonb,
        'xai', 'grok-test', 'checkpoint-v1', $5::timestamptz
      ) as result`,
      [WORKSPACE_ID, conversationId, [eventId], JSON.stringify({ [eventId]: source.rows[0].revision }), "2026-09-15T14:00:00.000Z"]
    );
    assert.equal(queued.rows[0].result.created, true);
    const jobId = queued.rows[0].result.jobId;

    const claimed = await db.query(
      "select public.claim_summarization_job($1::uuid, $2::timestamptz) as result",
      [jobId, "2026-09-15T14:00:01.000Z"]
    );
    assert.equal(claimed.rows[0].result.status, "processing");
    assert.equal(claimed.rows[0].result.attempt_count, 1);
    const secondClaim = await db.query(
      "select public.claim_summarization_job($1::uuid, $2::timestamptz) as result",
      [jobId, "2026-09-15T14:00:02.000Z"]
    );
    assert.equal(secondClaim.rows[0].result, null);

    const output = {
      summary: "The user prefers concise design reviews.",
      topics: ["Design feedback"],
      keyDecisions: [],
      openThreads: [],
      claims: [{
        predicate: "design_review_preference",
        value: "concise",
        displayText: "The user prefers concise design reviews.",
        confidence: 0.98,
        sensitivity: "normal",
        evidenceEventIds: [eventId]
      }]
    };
    const usage = {
      inputTokens: 120,
      outputTokens: 35,
      cachedInputTokens: 20,
      totalTokens: 155,
      estimatedCostUsd: null,
      exactCostUsd: 0.00021
    };
    const completed = await db.query(
      `select public.complete_summarization_job(
        $1::uuid, $2::jsonb, $3::jsonb, 'grok-test-20260915', 'xai-request-1', $4::timestamptz
      ) as result`,
      [jobId, JSON.stringify(output), JSON.stringify(usage), "2026-09-15T14:00:03.000Z"]
    );
    assert.equal(completed.rows[0].result.completed, true);
    assert.equal(completed.rows[0].result.claimCount, 1);

    await db.exec("reset role");
    const persisted = await db.query(`
      select
        (select status from public.summarization_jobs where id = $1) as job_status,
        (select count(*)::int from public.checkpoints where summarization_job_id = $1) as checkpoints,
        (select count(*)::int from public.checkpoint_events) as checkpoint_events,
        (select count(*)::int from public.memory_claims) as claims,
        (select count(*)::int from public.memory_evidence) as evidence,
        (select count(*)::int from public.diagnostic_events where stage = 'summarization_complete') as diagnostics,
        (select total_tokens from public.checkpoints where summarization_job_id = $1) as total_tokens,
        (select exact_cost_usd::float8 from public.checkpoints where summarization_job_id = $1) as exact_cost_usd
    `, [jobId]);
    assert.deepEqual(persisted.rows[0], {
      job_status: "completed",
      checkpoints: 1,
      checkpoint_events: 1,
      claims: 1,
      evidence: 2,
      diagnostics: 1,
      total_tokens: 155,
      exact_cost_usd: 0.00021
    });

    const replay = await db.query(
      `select public.complete_summarization_job(
        $1::uuid, $2::jsonb, $3::jsonb, 'grok-test-20260915', 'xai-request-1', $4::timestamptz
      ) as result`,
      [jobId, JSON.stringify(output), JSON.stringify(usage), "2026-09-15T14:00:04.000Z"]
    );
    assert.equal(replay.rows[0].result.idempotentReplay, true);

    const claim = await db.query("select id, origin_checkpoint_id from public.memory_claims limit 1");
    assert.equal(claim.rows[0].origin_checkpoint_id, completed.rows[0].result.checkpointId);

    const edited = await db.query(
      `select public.edit_checkpoint_summary(
        $1::uuid, $2::uuid, 'The user prefers brief, direct design reviews.', $3::uuid, $4::timestamptz
      ) as result`,
      [WORKSPACE_ID, completed.rows[0].result.checkpointId, USER_ID, "2026-09-15T14:01:00.000Z"]
    );
    assert.equal(edited.rows[0].result.version, 2);
    const editedCheckpointId = edited.rows[0].result.checkpointId;
    const versions = await db.query("select version, status, summary_text from public.checkpoints order by version");
    assert.deepEqual(versions.rows, [
      { version: 1, status: "superseded", summary_text: "The user prefers concise design reviews." },
      { version: 2, status: "user_edited", summary_text: "The user prefers brief, direct design reviews." }
    ]);

    const reviewed = await db.query(
      "select public.review_memory_claim($1::uuid, $2::uuid, 'yes', $3::uuid, $4::timestamptz) as result",
      [WORKSPACE_ID, claim.rows[0].id, USER_ID, "2026-09-15T14:02:00.000Z"]
    );
    assert.equal(reviewed.rows[0].result.status, "confirmed");
    assert.equal(reviewed.rows[0].result.reviewState, "yes");

    const secondChat = await seedConversation(db, "another-source-chat");
    const conflicting = await db.query(
      `insert into public.memory_claims (
        workspace_id, conversation_id, subject, predicate, value, display_text,
        scope_type, authority, status, review_state, confidence, observed_at,
        sensitivity, source_availability, origin_checkpoint_id
      ) values (
        $1, $2, 'user', 'design_review_preference', to_jsonb('detailed'::text),
        'The user prefers detailed design reviews.', 'workspace', 'derived',
        'provisional', 'unreviewed', 0.8, $3, 'normal', 'available', $4
      ) returning id`,
      [WORKSPACE_ID, secondChat, "2026-09-15T14:03:00.000Z", null]
    );
    const conflict = await db.query("select id, left_claim_id, right_claim_id, status from public.memory_conflicts limit 1");
    assert.equal(conflict.rows[0].left_claim_id, claim.rows[0].id);
    assert.equal(conflict.rows[0].right_claim_id, conflicting.rows[0].id);
    assert.equal(conflict.rows[0].status, "unresolved");

    const resolved = await db.query(
      "select public.resolve_memory_conflict($1::uuid, $2::uuid, 'keep_left', $3::uuid, $4::timestamptz) as result",
      [WORKSPACE_ID, conflict.rows[0].id, USER_ID, "2026-09-15T14:04:00.000Z"]
    );
    assert.equal(resolved.rows[0].result.status, "resolved");
    const claimStates = await db.query("select id, status, review_state from public.memory_claims order by created_at");
    assert.deepEqual(claimStates.rows, [
      { id: claim.rows[0].id, status: "confirmed", review_state: "yes" },
      { id: conflicting.rows[0].id, status: "superseded", review_state: "no" }
    ]);

    const deleted = await db.query(
      "select public.delete_checkpoint_summary($1::uuid, $2::uuid, $3::uuid, $4::timestamptz) as result",
      [WORKSPACE_ID, editedCheckpointId, USER_ID, "2026-09-15T14:05:00.000Z"]
    );
    assert.equal(deleted.rows[0].result.status, "deleted");
    const removedText = await db.query("select status, summary_text from public.checkpoints where id = $1", [editedCheckpointId]);
    assert.deepEqual(removedText.rows[0], { status: "deleted", summary_text: "[Deleted by user]" });
    const reviewHistory = await db.query("select count(*)::int as count from public.memory_claim_reviews");
    assert.equal(reviewHistory.rows[0].count, 3);

    await db.exec("set role authenticated");
    await db.exec(`set request.jwt.claim.sub = '${USER_ID}'`);
    await assert.rejects(
      () => db.query("select public.claim_summarization_job($1::uuid)", [jobId]),
      /permission denied/
    );
    await assert.rejects(
      () => db.query("select public.review_memory_claim($1::uuid, $2::uuid, 'yes', $3::uuid)", [WORKSPACE_ID, claim.rows[0].id, USER_ID]),
      /permission denied/
    );
  } finally {
    await db.close();
  }
});


test("mobile evidence commits atomically, rejects contradictions, and keeps source dates unknown", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.exec(await readFile(new URL("../supabase/migrations/20261002062250_mobile_capture_evidence.sql", import.meta.url), "utf8"));
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id, owner_user_id) values ($1, $2)", [WORKSPACE_ID, USER_ID]);
    const batch = validBatchV2({ surface: "android", reason: "accessibility", coverage: { state: "partial", gapBefore: true, backfillAvailable: false } });
    batch.captureClient.type = "accessibility";
    batch.captureClient.os = "android";
    const evidence = { version: 1, conversationIdentity: "local_session", messageIdentity: "local_sequence", timestampBasis: "observed", orderBasis: "session_sequence", completeness: "unknown", titleBasis: "placeholder" };
    Object.assign(batch.events[0], { conversationId: "android-session:test", sourceLocator: "android-session:test", sourceUrl: null, providerMessageId: null, messageTimestamp: null, captureEvidence: evidence });
    const rpc = "ingest_capture_batch_v2_evidence";
    await db.exec("set role authenticated");
    await assert.rejects(() => callIngestionV2(db, batch, `${WORKSPACE_ID}/chatgpt/2026/10/02/${batch.batchId}.json`, "a".repeat(64), rpc));
    await db.exec("reset role; set role service_role");
    const receipt = await callIngestionV2(db, batch, `${WORKSPACE_ID}/chatgpt/2026/10/02/${batch.batchId}.json`, "a".repeat(64), rpc);
    assert.equal(receipt.inserted, 1);
    assert.equal((await callIngestionV2(db, batch, `${WORKSPACE_ID}/chatgpt/2026/10/02/${batch.batchId}.json`, "a".repeat(64), rpc)).idempotentReplay, true);
    await db.exec("reset role");
    const event = (await db.query("select capture_evidence, message_timestamp, captured_at, source_locator from public.conversation_events")).rows[0];
    assert.deepEqual(event.capture_evidence, evidence);
    assert.equal(event.message_timestamp, null);
    assert.equal(event.source_locator, "android-session:test");
    await db.exec("set role service_role");
    const rollup = (await db.query("select * from public.conversation_activity_rollup($1)", [WORKSPACE_ID])).rows[0];
    assert.equal(rollup.source_message_at, null);
    assert.equal(rollup.first_new_content_at, null);
    const bad = structuredClone(batch);
    bad.batchId = "90000000-0000-4000-8000-000000000099";
    bad.events[0].eventId = "evt_invalid_evidence";
    bad.events[0].captureEvidence.completeness = "complete";
    await assert.rejects(() => callIngestionV2(db, bad, `${WORKSPACE_ID}/chatgpt/2026/10/02/${bad.batchId}.json`, "b".repeat(64), rpc), /capture_evidence_valid/);
    await db.exec("reset role");
    assert.equal((await db.query("select count(*)::int as count from public.ingestion_batches")).rows[0].count, 1);
    assert.equal((await db.query("select count(*)::int as count from public.conversation_events")).rows[0].count, 1);
  } finally { await db.close(); }
});

test("deletion records accept every supported browser and desktop source", async () => {
  const db = await historicalClaimsDatabase();
  try {
    await db.query('insert into auth.users (id) values ($1)',[USER_ID]);
    await db.query('insert into public.workspaces (id,owner_user_id) values ($1,$2)',[WORKSPACE_ID,USER_ID]);
    for (const provider of ['chatgpt','claude','gemini','codex','claude_code','antigravity']) {
      await db.query('insert into public.deleted_conversations (workspace_id,provider,provider_conversation_id) values ($1,$2,$3)',[WORKSPACE_ID,provider,'disposable:'+provider]);
    }
    assert.equal((await db.query('select count(*)::int as n from public.deleted_conversations')).rows[0].n,6);
  } finally {await db.close();}
});

test("archive chunk completion advances safely and cannot finish a newer deletion", async () => {
  const db=await historicalClaimsDatabase();
  try {
    await db.query('insert into auth.users (id) values ($1)',[USER_ID]);
    await db.query('insert into public.workspaces (id,owner_user_id) values ($1,$2)',[WORKSPACE_ID,USER_ID]);
    const op='10000000-0000-4000-8000-000000000001',next='10000000-0000-4000-8000-000000000002';
    await db.query(`insert into public.deleted_conversations(workspace_id,provider,provider_conversation_id,operation_id,archive_cleanup_keys)
      values ($1,'chatgpt','source',$2,array['old-a','old-b'])`,[WORKSPACE_ID,op]);
    const call=async(operation,results)=>(await db.query(`select public.finish_chat_archive_chunk($1,'chatgpt','source',$2,$3::jsonb) as result`,[WORKSPACE_ID,operation,JSON.stringify(results)])).rows[0].result;
    await db.exec('set role authenticated');
    await assert.rejects(()=>call(op,[]),/permission denied/);
    await db.exec('reset role; set role service_role');
    assert.equal((await call(op,[{key:'old-a',missing:true}])).pending,true);
    assert.equal((await call(op,[{key:'old-a',missing:true}])).pending,true);
    await db.exec('reset role');
    assert.deepEqual((await db.query('select archive_cleanup_keys from public.deleted_conversations')).rows[0].archive_cleanup_keys,['old-b']);
    await db.query('update public.deleted_conversations set operation_id=$1,archive_cleanup_keys=array[\'new-copy\'],archive_reconciled_at=null',[next]);
    await db.exec('set role service_role');
    assert.equal((await call(op,[{key:'old-b',missing:true}])).stale,true);
    assert.equal((await call(next,[{key:'new-copy',missing:true}])).pending,false);
    await db.exec('reset role');
    const row=(await db.query('select archive_cleanup_keys,archive_reconciled_at from public.deleted_conversations')).rows[0];
    assert.deepEqual(row.archive_cleanup_keys,[]);assert.ok(row.archive_reconciled_at);
  } finally {await db.close();}
});

test("archive chunk index updates preserve the unrelated chat in a shared archive", async()=>{
  const db=await historicalClaimsDatabase();
  try{
    await db.query('insert into auth.users(id) values ($1)',[USER_ID]);
    await db.query('insert into public.workspaces(id,owner_user_id) values ($1,$2)',[WORKSPACE_ID,USER_ID]);
    const batch=validBatch();batch.events[0].conversationId='remove-source';
    batch.events.push({...batch.events[0],eventId:'evt_keep',conversationId:'keep-source',providerMessageId:'keep-message',text:'invented unrelated text'});
    await db.exec('set role service_role');
    const key=`${WORKSPACE_ID}/chatgpt/test/${batch.batchId}.json`;
    await callIngestion(db,batch,key);
    await db.exec('reset role');
    const op='10000000-0000-4000-8000-000000000001';
    await db.query(`insert into public.deleted_conversations(workspace_id,provider,provider_conversation_id,operation_id,archive_cleanup_keys)
      values ($1,'chatgpt','remove-source',$2,array[$3::text])`,[WORKSPACE_ID,op,key]);
    await db.query("delete from public.conversations where provider_conversation_id='remove-source'");
    await db.exec('set role service_role');
    const result=await db.query(`select public.finish_chat_archive_chunk($1,'chatgpt','remove-source',$2,$3::jsonb) as receipt`,[WORKSPACE_ID,op,JSON.stringify([{key,sha256:'b'.repeat(64),bytes:42,providerConversationIds:['keep-source']}])]);
    assert.equal(result.rows[0].receipt.pending,false);
    await db.exec('reset role');
    const index=(await db.query('select payload_sha256,payload_bytes,provider_conversation_ids from public.ingestion_batches')).rows[0];
    assert.equal(index.payload_sha256,'b'.repeat(64));assert.equal(Number(index.payload_bytes),42);assert.deepEqual(index.provider_conversation_ids,['keep-source']);
    assert.equal((await db.query('select text_content from public.conversation_events')).rows[0].text_content,'invented unrelated text');
  }finally{await db.close();}
});

test("current full schema preserves ten intentional turns and same-provider-ID revisions without copies", async () => {
  const db = await migratedDatabase();
  try {
    await db.query("insert into auth.users (id) values ($1)",[USER_ID]);
    await db.query("insert into public.workspaces (id,owner_user_id) values ($1,$2)",[WORKSPACE_ID,USER_ID]);
    await db.exec("set role service_role");
    const template=validBatchV2();
    const turn=(i)=>({...template.events[0],eventId:`evt_turn_${i}`,providerMessageId:`message-${i}`,sequence:i,
      role:i%2?"assistant":"user",text:i%2?`Invented reply ${i}`:"Please repeat this intentional prompt.",contentHash:`hash-${i}`});
    const first={...template,events:Array.from({length:8},(_,i)=>turn(i))};
    assert.equal((await callIngestionV2(db,first,`${WORKSPACE_ID}/chatgpt/2026/10/24/${first.batchId}.json`)).inserted,8);
    const second={...template,batchId:"8453ae63-3211-468c-8852-dd159c22a321",events:Array.from({length:10},(_,i)=>turn(i))};
    const result=await callIngestionV2(db,second,`${WORKSPACE_ID}/chatgpt/2026/10/24/${second.batchId}.json`,"d".repeat(64));
    assert.equal(result.inserted,2);assert.equal(result.duplicates,8);
    const revision={...template,batchId:"8453ae63-3211-468c-8852-dd159c22a322",events:[{...turn(9),eventId:"evt_new_adapter_key",text:"Corrected final reply",contentHash:"revised"}]};
    assert.equal((await callIngestionV2(db,revision,`${WORKSPACE_ID}/chatgpt/2026/10/24/${revision.batchId}.json`,"e".repeat(64))).updated,1);
    await db.exec("reset role");
    const rows=(await db.query("select role,text_content as text from public.conversation_events order by sequence")).rows;
    assert.equal(rows.length,10);assert.equal(rows[0].text,turn(0).text);assert.equal(rows[9].text,"Corrected final reply");
    assert.equal((await db.query("select count(*)::int as n from public.conversation_events where role='user'")).rows[0].n,5);
  } finally { await db.close(); }
});

test("forward mobile evidence upgrades the deployed baseline without replacing activity rules", async () => {
  const db = await deployedBaselineWithoutMobile();
  try {
    const before = (await db.query("select pg_get_functiondef('public.conversation_activity_rollup(uuid)'::regprocedure) as body")).rows[0].body;
    await db.exec(await readFile(mobileForwardMigration, "utf8"));
    assert.equal((await db.query("select exists(select 1 from information_schema.columns where table_schema='public' and table_name='conversation_events' and column_name='capture_evidence') as present")).rows[0].present, true);
    assert.equal((await db.query("select pg_get_functiondef('public.conversation_activity_rollup(uuid)'::regprocedure) as body")).rows[0].body, before);
    await db.query("insert into auth.users (id) values ($1)", [USER_ID]);
    await db.query("insert into public.workspaces (id,owner_user_id) values ($1,$2)", [WORKSPACE_ID,USER_ID]);
    const batch = validBatchV2({surface:"android",reason:"accessibility",coverage:{state:"partial",gapBefore:true,backfillAvailable:false}});
    batch.captureClient.type="accessibility";batch.captureClient.os="android";
    const evidence={version:1,conversationIdentity:"local_session",messageIdentity:"local_sequence",timestampBasis:"observed",orderBasis:"session_sequence",completeness:"unknown",titleBasis:"placeholder"};
    Object.assign(batch.events[0],{conversationId:"android-session:forward-test",sourceLocator:"android-session:forward-test",sourceUrl:null,providerMessageId:null,messageTimestamp:null,captureEvidence:evidence});
    await db.exec("set role authenticated");
    await assert.rejects(()=>callIngestionV2(db,batch,`${WORKSPACE_ID}/chatgpt/2026/10/25/${batch.batchId}.json`,"a".repeat(64),"ingest_capture_batch_v2_evidence"),/permission denied/);
    await db.exec("reset role; set role service_role");
    assert.equal((await callIngestionV2(db,batch,`${WORKSPACE_ID}/chatgpt/2026/10/25/${batch.batchId}.json`,"a".repeat(64),"ingest_capture_batch_v2_evidence")).inserted,1);
    assert.equal((await callIngestionV2(db,batch,`${WORKSPACE_ID}/chatgpt/2026/10/25/${batch.batchId}.json`,"a".repeat(64),"ingest_capture_batch_v2_evidence")).idempotentReplay,true);
    await db.exec("reset role");
    const row=(await db.query("select capture_evidence,message_timestamp,provider_message_id from public.conversation_events")).rows[0];
    assert.deepEqual(row,{capture_evidence:evidence,message_timestamp:null,provider_message_id:null});
    const bad=structuredClone(batch);bad.batchId="90000000-0000-4000-8000-000000000199";bad.events[0].eventId="evt_forward_bad_evidence";bad.events[0].captureEvidence.completeness="complete";
    await db.exec("set role service_role");
    await assert.rejects(()=>callIngestionV2(db,bad,`${WORKSPACE_ID}/chatgpt/2026/10/25/${bad.batchId}.json`,"b".repeat(64),"ingest_capture_batch_v2_evidence"),/mobile_observation_valid/);
    await db.exec("reset role");
    assert.deepEqual((await db.query("select (select count(*)::int from public.ingestion_batches) as batches,(select count(*)::int from public.conversation_events) as events")).rows[0],{batches:1,events:1});
    await db.exec("set role service_role");
    const browser=validBatchV2();browser.batchId="90000000-0000-4000-8000-000000000200";
    assert.equal((await callIngestionV2(db,browser,`${WORKSPACE_ID}/chatgpt/2026/10/25/${browser.batchId}.json`,"c".repeat(64))).inserted,1);
  } finally {await db.close();}
});

test("forward mobile evidence also upgrades the local historical mobile schema",async()=>{
  const db=await deployedBaselineWithoutMobile();
  try {
    await db.exec(await readFile(new URL("../supabase/migrations/20261002062250_mobile_capture_evidence.sql",import.meta.url),"utf8"));
    const before=(await db.query("select pg_get_functiondef('public.conversation_activity_rollup(uuid)'::regprocedure) as body")).rows[0].body;
    await db.exec(await readFile(mobileForwardMigration,"utf8"));
    await db.exec(await readFile(mobileForwardMigration,"utf8"));
    assert.equal((await db.query("select pg_get_functiondef('public.conversation_activity_rollup(uuid)'::regprocedure) as body")).rows[0].body,before);
    assert.equal((await db.query("select has_function_privilege('authenticated','public.ingest_capture_batch_v2_evidence(uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,jsonb,jsonb,jsonb,jsonb)','EXECUTE') as allowed")).rows[0].allowed,false);
  } finally {await db.close();}
});
