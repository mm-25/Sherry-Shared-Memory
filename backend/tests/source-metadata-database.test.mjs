import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {validBatchV2,USER_ID,WORKSPACE_ID} from './fixtures.mjs';
const metadata={version:1,titleBasis:'source',conversationIdentity:'provider',messageIdentity:'provider',timestampBasis:'unknown',linksStatus:'inspected',attachmentsStatus:'not_inspected'};
async function database(){
 const db=new PGlite();await db.exec(`create schema auth;create schema extensions;create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
 const dir=new URL('../supabase/migrations/',import.meta.url);
 for(const name of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()) await db.exec((await readFile(new URL(name,dir),'utf8')).replace('create extension if not exists pgcrypto with schema extensions;\n\n',''));
 await db.query('insert into auth.users values ($1)',[USER_ID]);await db.query('insert into workspaces(id,owner_user_id) values($1,$2)',[WORKSPACE_ID,USER_ID]);return db;
}
async function ingest(db,batch,hash='a'.repeat(64)){
 const args=[USER_ID,WORKSPACE_ID,batch.batchId,batch.provider,batch.providerFamily,batch.product,batch.surface,batch.reason,`${WORKSPACE_ID}/chatgpt/test/${batch.batchId}.json`,hash,100,{},batch.captureClient,batch.coverage,batch.events,batch.conversationUpdates||[]];
 return (await db.query(`select public.ingest_capture_batch_v2_source_metadata(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
}
function update(batch, title='Renamed') {return {...batch,batchId:crypto.randomUUID(),events:[],conversationUpdates:[{conversationId:batch.events[0].conversationId,chatTitle:title,capturedAt:'2026-10-30T10:00:00Z',sourceMetadata:{...metadata,messageIdentity:'unknown',timestampBasis:'unknown',linksStatus:'unknown',attachmentsStatus:'unknown'}}]};}
test('source metadata transaction preserves counts/activity on title change, stale observation and replay; separates identical messages and identities',async()=>{
 const db=await database();try{
 const batch=validBatchV2();batch.events[0].sourceMetadata={...metadata};
 assert.equal((await ingest(db,batch)).inserted,1);
 const dated=structuredClone(batch);dated.batchId=crypto.randomUUID();dated.events[0].messageTimestamp='2026-09-14T13:00:00Z';dated.events[0].sourceMetadata.timestampBasis='source';assert.equal((await ingest(db,dated)).duplicates,1);
 const alternateKey=structuredClone(dated);alternateKey.batchId=crypto.randomUUID();alternateKey.events[0].eventId='evt_alternate_provider_key';assert.equal((await ingest(db,alternateKey)).duplicates,1);
 const before=(await db.query('select title,last_captured_at,updated_at from conversations')).rows[0];
 const beforeEvent=(await db.query('select * from conversation_events')).rows[0];
 const changed=update(batch);const changedReceipt=await ingest(db,changed);assert.equal(changedReceipt.metadataUpdated,1);assert.equal(changedReceipt.metadataReceived,1);
 assert.deepEqual((await db.query('select last_captured_at,updated_at from conversations')).rows[0],{last_captured_at:before.last_captured_at,updated_at:before.updated_at});
 assert.deepEqual((await db.query('select * from conversation_events')).rows[0],beforeEvent);
 assert.equal((await db.query('select title from conversations')).rows[0].title,'Renamed');
 assert.equal((await ingest(db,changed)).idempotentReplay,true);
 await assert.rejects(()=>ingest(db,changed,'b'.repeat(64)),/idempotency_payload_mismatch/);
 const unchanged=update(batch,'Renamed');unchanged.conversationUpdates[0].capturedAt='2026-10-30T12:00:00Z';assert.equal((await ingest(db,unchanged)).metadataUpdated,0);
 const olderRename=update(batch,'Wrong older rename');olderRename.conversationUpdates[0].capturedAt='2026-10-30T11:00:00Z';assert.equal((await ingest(db,olderRename)).metadataUpdated,0);
 const stale=update(batch,'Stale');stale.conversationUpdates[0].capturedAt='2020-01-01T00:00:00Z';assert.equal((await ingest(db,stale)).metadataUpdated,0);
 const other=structuredClone(batch);other.batchId=crypto.randomUUID();other.events[0].conversationId='different-source';other.events[0].eventId='evt_different_source';assert.equal((await ingest(db,other)).inserted,1);
 const repeat=structuredClone(batch);repeat.batchId=crypto.randomUUID();repeat.events[0].eventId='evt_distinct_repeat';repeat.events[0].providerMessageId='message-distinct';repeat.events[0].capturedAt='2026-10-30T11:00:00Z';assert.equal((await ingest(db,repeat)).inserted,1);
 assert.equal((await db.query('select count(*)::int as n from conversation_events')).rows[0].n,3);
 const unknown=update(batch);unknown.conversationUpdates[0].conversationId='never-seen';await assert.rejects(()=>ingest(db,unknown),/source_metadata_identity_unproven/);
 const local=structuredClone(batch);local.batchId=crypto.randomUUID();local.events[0].conversationId='local-chat';local.events[0].sourceMetadata.conversationIdentity='local';await ingest(db,local);
 const crossDevice=update(local);crossDevice.captureClient={...local.captureClient,deviceId:'other-device'};crossDevice.conversationUpdates[0].sourceMetadata.conversationIdentity='local';await assert.rejects(()=>ingest(db,crossDevice),/source_metadata_identity_unproven/);
 const legacy=structuredClone(batch);legacy.batchId=crypto.randomUUID();legacy.events[0].conversationId='legacy-unknown';delete legacy.events[0].sourceMetadata;await ingest(db,legacy);
 await assert.rejects(()=>ingest(db,update(legacy)),/source_metadata_identity_unproven/);
 const malformed=structuredClone(batch);malformed.batchId=crypto.randomUUID();malformed.events[0].sourceMetadata.titleBasis='invented';await assert.rejects(()=>ingest(db,malformed),/invalid_source_metadata/);
 const beforeBatches=(await db.query('select count(*)::int n from ingestion_batches')).rows[0].n;
 const missing=update(batch);missing.conversationUpdates[0].chatTitle=null;await assert.rejects(()=>ingest(db,missing),/invalid_source_metadata_update/);
 assert.equal((await db.query('select count(*)::int n from ingestion_batches')).rows[0].n,beforeBatches);
 const android=structuredClone(batch);android.batchId=crypto.randomUUID();android.surface='android';android.captureClient.type='accessibility';android.captureClient.os='android';
 Object.assign(android.events[0],{conversationId:'android-session:new',sourceLocator:'android-session:new',sourceUrl:null,providerMessageId:null,messageTimestamp:null,
  captureEvidence:{version:1,conversationIdentity:'local_session',messageIdentity:'local_sequence',timestampBasis:'observed',orderBasis:'session_sequence',completeness:'unknown',titleBasis:'placeholder'},
  sourceMetadata:{...metadata,titleBasis:'generic',conversationIdentity:'local',messageIdentity:'local',timestampBasis:'observed',linksStatus:'not_inspected'}});
 await ingest(db,android);android.batchId=crypto.randomUUID();android.events[0].chatTitle='Actual native title';android.events[0].captureEvidence.titleBasis='source';android.events[0].sourceMetadata.titleBasis='source';
 assert.equal((await ingest(db,android)).duplicates,1);
 assert.equal((await db.query("select capture_evidence->>'titleBasis' as title from conversation_events where provider_conversation_id='android-session:new'")).rows[0].title,'source');
 const nativeBefore=(await db.query("select r.first_new_content_at from conversation_activity_rollup($1) r join conversations c on c.id=r.conversation_id where c.provider_conversation_id='android-session:new'",[WORKSPACE_ID])).rows[0].first_new_content_at;
 android.batchId=crypto.randomUUID();android.events[0].capturedAt='2026-10-30T12:00:00Z';await ingest(db,android);
 assert.equal((await db.query("select r.first_new_content_at from conversation_activity_rollup($1) r join conversations c on c.id=r.conversation_id where c.provider_conversation_id='android-session:new'",[WORKSPACE_ID])).rows[0].first_new_content_at.getTime(),nativeBefore.getTime());
 android.batchId=crypto.randomUUID();android.events[0].eventId='evt_native_distinct';android.events[0].capturedAt='2026-10-30T13:00:00Z';await ingest(db,android);
 assert.equal((await db.query("select r.first_new_content_at from conversation_activity_rollup($1) r join conversations c on c.id=r.conversation_id where c.provider_conversation_id='android-session:new'",[WORKSPACE_ID])).rows[0].first_new_content_at.toISOString(),'2026-10-30T13:00:00.000Z');
 const boundary=update(batch);boundary.conversationUpdates[0]._sherryDeletionOperation='initial';await db.query("insert into deleted_conversations(workspace_id,provider,provider_conversation_id,archive_reconciled_at) values($1,'chatgpt','conversation-123',now())",[WORKSPACE_ID]);
 await assert.rejects(()=>ingest(db,boundary),/capture_deletion_boundary_changed/);
 const fallback=structuredClone(batch);fallback.batchId=crypto.randomUUID();fallback.events[0].conversationId='fallback-time';fallback.events[0].messageTimestamp='2030-01-01T00:00:00Z';fallback.events[0].sourceMetadata.timestampBasis='session_fallback';await ingest(db,fallback);
 const activity=await db.query("select r.source_message_at from conversation_activity_rollup($1) r join conversations c on c.id=r.conversation_id where c.provider_conversation_id='fallback-time'",[WORKSPACE_ID]);assert.equal(activity.rows[0].source_message_at,null);
 await db.exec('set role authenticated');await assert.rejects(()=>ingest(db,batch),/permission denied/);
 }finally{await db.close();}
});

test('local message IDs never merge across devices and titles retain their matching newest evidence across legacy and unordered batches',async()=>{
 const db=await database();
 try{
  const first=validBatchV2({batchId:crypto.randomUUID()});first.events[0].sourceMetadata={...metadata,messageIdentity:'local'};first.events[0].providerMessageId='local:1';
  await ingest(db,first);
  const second=structuredClone(first);second.batchId=crypto.randomUUID();second.captureClient.deviceId='other-device';second.events[0].eventId='evt_other_device';second.events[0].text='A distinct message from another device';second.events[0].contentHash='abcdef12';
  assert.equal((await ingest(db,second)).inserted,1);
  const messages=(await db.query('select event_key,text_content,provider_message_id from conversation_events order by id')).rows;
  assert.equal(messages.length,2);assert.equal(messages[0].text_content,first.events[0].text);assert.equal(messages[1].text_content,second.events[0].text);
  assert.deepEqual(messages.map(e=>e.provider_message_id),['local:1','local:1']);
  const renamed=update(first,'Newest source title');renamed.conversationUpdates[0].capturedAt='2026-10-30T12:00:00Z';await ingest(db,renamed);
  const legacy=structuredClone(first);legacy.batchId=crypto.randomUUID();delete legacy.events[0].sourceMetadata;legacy.events[0].chatTitle='Old frozen legacy title';
  const legacyBytes=JSON.stringify(legacy);
  const args=[USER_ID,WORKSPACE_ID,legacy.batchId,legacy.provider,legacy.providerFamily,legacy.product,legacy.surface,legacy.reason,`${WORKSPACE_ID}/chatgpt/test/${legacy.batchId}.json`,'b'.repeat(64),100,{},legacy.captureClient,legacy.coverage,legacy.events];
  await db.query(`select public.ingest_capture_batch_v2(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args);
  assert.equal(JSON.stringify(legacy),legacyBytes);
  let saved=(await db.query('select title,source_metadata,source_metadata_observed_at from conversations')).rows[0];
  assert.equal(saved.title,'Newest source title');assert.equal(saved.source_metadata.titleBasis,'source');assert.equal(saved.source_metadata_observed_at.toISOString(),'2026-10-30T12:00:00.000Z');
  const unordered=validBatchV2({batchId:crypto.randomUUID()});Object.assign(unordered.events[0],{conversationId:'unordered',chatTitle:'Newest original title',capturedAt:'2026-10-30T12:00:00Z',sourceMetadata:{...metadata}});
  unordered.events.push({...unordered.events[0],eventId:'evt_older_derived',providerMessageId:'message-older',chatTitle:'Older derived title',capturedAt:'2026-10-30T11:00:00Z',sourceMetadata:{...metadata,titleBasis:'derived'}});
  await ingest(db,unordered);saved=(await db.query("select title,source_metadata,source_metadata_observed_at from conversations where provider_conversation_id='unordered'")).rows[0];
  assert.equal(saved.title,'Newest original title');assert.equal(saved.source_metadata.titleBasis,'source');assert.equal(saved.source_metadata_observed_at.toISOString(),'2026-10-30T12:00:00.000Z');
 }finally{await db.close();}
});
