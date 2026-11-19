import assert from 'node:assert/strict';
import test from 'node:test';
import {validateCaptureBatch} from '../src/validation.js';
import {redactCaptureBatch} from '../src/redaction.js';
import {validBatch,validBatchV2} from './fixtures.mjs';
const metadata = {version:1,titleBasis:'source',conversationIdentity:'provider',messageIdentity:'provider',timestampBasis:'unknown',linksStatus:'inspected',attachmentsStatus:'not_inspected'};
function batch(){const value=validBatchV2();value.events[0].sourceMetadata={...metadata};return value;}
test('source metadata survives validation and legacy payloads stay unmodified',()=>{
  assert.deepEqual(validateCaptureBatch(batch()).value.events[0].sourceMetadata,metadata);
  for(const value of [validBatch(),validBatchV2()]) assert.equal(Object.hasOwn(validateCaptureBatch(value).value.events[0],'sourceMetadata'),false);
});
test('malformed metadata and conflicting source facts fail closed without crashing',()=>{
  for(const patch of [{version:2},{titleBasis:'original'},{extra:true},{messageIdentity:'fake'},{timestampBasis:'source'},{linksStatus:null}]){
    const value=batch();Object.assign(value.events[0].sourceMetadata,patch);assert.equal(validateCaptureBatch(value).ok,false,JSON.stringify(patch));
  }
  const value=batch(); value.events[0].providerMessageId=null; assert.equal(validateCaptureBatch(value).ok,false);
  value.events[0].links=null; assert.doesNotThrow(()=>validateCaptureBatch(value));
});
test('metadata-only v2 batches require exact identity and bounded title observations',()=>{
  const update={conversationId:'conversation-123',chatTitle:'New title',capturedAt:'2026-10-30T10:00:00Z',sourceMetadata:{...metadata,messageIdentity:'unknown',linksStatus:'unknown',attachmentsStatus:'unknown'}};
  const value=validBatchV2({events:[],conversationUpdates:[update]});
  assert.equal(validateCaptureBatch(value).ok,true);
  assert.deepEqual(validateCaptureBatch(value).value.conversationUpdates,[update]);
  for(const patch of [{conversationId:''},{sourceMetadata:{...update.sourceMetadata,conversationIdentity:'unknown'}},{text:'fake message'},{capturedAt:'not a date'}]) assert.equal(validateCaptureBatch({...value,conversationUpdates:[{...update,...patch}]}).ok,false);
  assert.equal(validateCaptureBatch({...value,schemaVersion:1}).ok,false);
  assert.equal(validateCaptureBatch({...value,conversationUpdates:[]}).ok,false);
});
test('metadata-only titles are redacted before archive and upload',()=>{
  const value=validBatchV2({events:[],conversationUpdates:[{conversationId:'c',chatTitle:'password: secret-value',capturedAt:'2026-10-30T10:00:00Z',sourceMetadata:{...metadata}}]});
  const result=redactCaptureBatch(value);assert.equal(result.batch.conversationUpdates[0].chatTitle,'password: [REDACTED_CREDENTIAL]');assert.equal(result.summary.total,1);
});

test('new evidence excludes session fallback from original dates and preserves distinct repeated messages in activity', async()=>{
 const {activityFromEvents}=await import('../src/conversation-activity.js');
 const text='This is a genuinely repeated message with enough characters to expose the previous text-based collapse.';
 const events=[{id:1,event_key:'evt_first',text_content:text,role:'user',source_metadata:{...metadata,messageIdentity:'local',timestampBasis:'session_fallback'},message_timestamp:'2030-01-01T00:00:00Z',first_captured_at:'2026-10-29T00:00:00Z'},
 {id:2,event_key:'evt_second',text_content:text,role:'user',source_metadata:{...metadata,messageIdentity:'local',timestampBasis:'unknown'},message_timestamp:null,first_captured_at:'2026-10-30T00:00:00Z'}];
 assert.deepEqual(activityFromEvents({},events),{last_activity_at:'2026-10-30T00:00:00.000Z',last_activity_basis:'first_captured_message'});
});

test('worker archives and commits metadata-only updates with redaction, deletion generation and indexed targets',async()=>{
 const {handleRequest}=await import('../src/index.js');
 const {MemoryR2,configuredEnv,USER_ID,WORKSPACE_ID}=await import('./fixtures.mjs');
 const value=validBatchV2({events:[],conversationUpdates:[{conversationId:'conversation-123',chatTitle:'password: secret-value',capturedAt:'2026-10-30T10:00:00Z',sourceMetadata:{...metadata,messageIdentity:'unknown',linksStatus:'unknown',attachmentsStatus:'unknown'}}]});
 const store=new MemoryR2();let rpc;let index;
 const fetch=async(url,options={})=>{
   if(url.endsWith('/auth/v1/user'))return Response.json({id:USER_ID});
   if(url.includes('/workspaces?'))return Response.json([{id:WORKSPACE_ID}]);
   if(url.includes('/deleted_conversations?')){assert.ok(decodeURIComponent(url).includes('conversation-123'));return Response.json([]);}
   if(url.endsWith('/rpc/ingest_capture_batch_v2_source_metadata')){rpc=JSON.parse(options.body);return Response.json({status:'committed',received:0,inserted:0,updated:0,duplicates:0,metadataReceived:1,metadataUpdated:1});}
   if(url.includes('/ingestion_batches?')){index=JSON.parse(options.body);return Response.json(null);}
   throw new Error(url);
 };
 const response=await handleRequest(new Request('https://test/v1/capture/batches',{method:'POST',headers:{authorization:'Bearer test'},body:JSON.stringify(value)}),configuredEnv(store),{fetch});
 assert.equal(response.status,200);assert.equal((await response.json()).result.metadataReceived,1);
 assert.equal(rpc.p_events.length,0);assert.equal(rpc.p_conversation_updates[0]._sherryDeletionOperation,'initial');assert.equal(rpc.p_conversation_updates[0].chatTitle,'password: [REDACTED_CREDENTIAL]');
 assert.deepEqual(index.provider_conversation_ids,['conversation-123']);assert.equal(store.objects.size,1);
});

test('chat cleanup removes title-only copies and preserves other chats in mixed or metadata-only archives',async()=>{
 const {reconcileDeletedArchives}=await import('../src/index.js');
 const {MemoryR2,configuredEnv,WORKSPACE_ID}=await import('./fixtures.mjs');
 const store=new MemoryR2();
 const cases={mixed:{events:[{conversationId:'remove',text:'removed'},{conversationId:'keep',text:'kept'}],conversationUpdates:[{conversationId:'remove',chatTitle:'removed'},{conversationId:'keep',chatTitle:'kept'}]},
 metadataOnly:{events:[],conversationUpdates:[{conversationId:'remove',chatTitle:'removed'},{conversationId:'keep',chatTitle:'kept'}]},
 retainUpdates:{events:[{conversationId:'remove',text:'removed'}],conversationUpdates:[{conversationId:'keep',chatTitle:'kept'}]},
 removeAll:{events:[],conversationUpdates:[{conversationId:'remove',chatTitle:'removed'}]}};
 for(const [key,value] of Object.entries(cases))await store.put(key,JSON.stringify(value),{});
 let results;
 const fetch=async(url,options={})=>{
  if(url.includes('/deleted_conversations?'))return Response.json([{id:1,workspace_id:WORKSPACE_ID,provider:'chatgpt',provider_conversation_id:'remove',operation_id:'10000000-0000-4000-8000-000000000001',archive_cleanup_keys:Object.keys(cases)}]);
  if(url.includes('/conversations?'))return Response.json([]);
  if(url.endsWith('/rpc/finish_chat_archive_chunk')){results=JSON.parse(options.body).p_results;return Response.json({pending:false});}
  throw new Error(url);
 };
 assert.equal((await reconcileDeletedArchives(configuredEnv(store),fetch)).reconciled,1);
 for(const key of ['mixed','metadataOnly','retainUpdates']){const body=await(await store.get(key)).json();assert.equal(JSON.stringify(body).includes('removed'),false);assert.equal(body.conversationUpdates[0].chatTitle,'kept');assert.deepEqual(results.find(r=>r.key===key).providerConversationIds,['keep']);}
 assert.equal(await store.get('removeAll'),null);
});
