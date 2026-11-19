import assert from 'node:assert/strict';
import test from 'node:test';
import {searchMemory, getSource} from '../src/retrieval.js';
import {USER_ID, WORKSPACE_ID, configuredEnv, MemoryR2} from './fixtures.mjs';
const env = configuredEnv(new MemoryR2());
const identity = {userId:USER_ID,workspaceId:WORKSPACE_ID,provider:'claude',scopes:['memory:read']};
const source = {version:1,titleBasis:'derived',conversationIdentity:'provider',messageIdentity:'local',timestampBasis:'session_fallback',linksStatus:'not_inspected',attachmentsStatus:'unavailable'};
function fixture(event, {eventId=42, evidenceMissing=false}={}) {
  const conversation = {title:'Current provider title', source_metadata:{...source,titleBasis:'source'}};
  return async (url, options={}) => {
    const parsed = new URL(url); const path = parsed.pathname;
    if(path.endsWith('/retrieval_connections')) return Response.json([{read_enabled:true}]);
    if(path.endsWith('/workspace_retrieval_settings')) return Response.json([{financial_enabled:true,health_enabled:true,personal_enabled:true}]);
    if(path.endsWith('/rpc/search_memory_context')) {
      const request=JSON.parse(options.body);assert.equal(request.p_user_id,USER_ID);assert.equal(request.p_workspace_id,WORKSPACE_ID);
      // Actual SQL returns event_id, not source_event_id. observed_at may be a session fallback.
      return Response.json([{result_type:'excerpt',result_id:'11',event_id:eventId,content:'Invented evidence excerpt',observed_at:event.message_timestamp,metadata:{conversationTitle:conversation.title}}]);
    }
    if(path.endsWith('/conversation_events')) {
      assert.equal(parsed.searchParams.get('workspace_id'),`eq.${WORKSPACE_ID}`);
      assert.equal(parsed.searchParams.get('id'),'in.(42)');
      assert.match(parsed.searchParams.get('select'),/source_metadata/);
      return Response.json(evidenceMissing?[]:[{...event,id:42,conversations:conversation}]);
    }
    if(path.endsWith('/text_chunks')) {
      assert.equal(parsed.searchParams.get('workspace_id'),`eq.${WORKSPACE_ID}`);
      assert.match(parsed.searchParams.get('select'),/source_metadata/);
      return Response.json([{id:11,conversation_events:event,conversations:conversation}]);
    }
    if(path.endsWith('/sync_cursors')) return Response.json([]);
    if(path.endsWith('/retrieval_requests')) return Response.json(null);
    throw new Error(`Unexpected ${path}`);
  };
}
const event={message_timestamp:'2020-01-01T00:00:00Z',captured_at:'2026-10-30T10:00:00Z',source_metadata:source,coverage_state:'complete_observed_range'};
test('actual RPC event_id carries fallback, local identity and inspection evidence without presenting a source date',async()=>{
 const result=await searchMemory({...identity,query:'invented'},env,fixture(event));const row=result.results[0];
 assert.deepEqual(row.metadata.sourceMetadata,source);
 assert.equal(row.metadata.conversationSourceMetadata.titleBasis,'source');
 assert.equal(row.metadata.messageTimestamp,null);
 assert.equal(row.metadata.recordedMessageTimestamp,'2020-01-01T00:00:00Z');
 assert.equal(row.observed_at,'2026-10-30T10:00:00Z');
 assert.match(row.metadata.observationWarnings.join(' '),/session fallback/i);
 assert.match(row.metadata.observationWarnings.join(' '),/message identity is local/i);
 assert.match(row.metadata.observationWarnings.join(' '),/links.*not inspected/i);
 assert.match(row.metadata.observationWarnings.join(' '),/attachments.*unavailable/i);
});
test('source lookup classifies its raw fallback timestamp and current title independently',async()=>{
 const result=await getSource({...identity,type:'excerpt',id:'11'},env,fixture(event));
 assert.equal(result.messageTimestamp,null);assert.equal(result.recordedMessageTimestamp,event.message_timestamp);
 assert.deepEqual(result.sourceMetadata,source);assert.equal(result.conversationSourceMetadata.titleBasis,'source');
 assert.equal(result.conversation_events.message_timestamp,null);
 assert.equal(result.conversation_events.recorded_message_timestamp,event.message_timestamp);
 assert.match(result.observationWarnings.join(' '),/session fallback/i);
});
test('proven source dates survive evidence enrichment',async()=>{
 const original={...event,source_metadata:{...source,messageIdentity:'provider',timestampBasis:'source'}};
 const result=await searchMemory({...identity,query:'invented'},env,fixture(original));
 assert.equal(result.results[0].metadata.messageTimestamp,event.message_timestamp);
 assert.equal(result.results[0].metadata.observedAt,event.captured_at);
 assert.equal(result.results[0].observed_at,event.captured_at);
});
test('legacy populated dates and IDs remain unknown rather than acquiring source evidence',async()=>{
 const legacy={...event};delete legacy.source_metadata;
 const result=await searchMemory({...identity,query:'invented'},env,fixture(legacy));
 const metadata=result.results[0].metadata;
 assert.equal(metadata.sourceMetadata.timestampBasis,'unknown');assert.equal(metadata.sourceMetadata.messageIdentity,'unknown');
 assert.equal(metadata.messageTimestamp,null);assert.equal(metadata.recordedMessageTimestamp,event.message_timestamp);
 assert.match(metadata.observationWarnings.join(' '),/original message date.*unknown/i);
});
test('missing source row and missing event ID both receive explicit unknown evidence',async()=>{
 for(const options of [{evidenceMissing:true},{eventId:null}]){
  const result=await searchMemory({...identity,query:'invented'},env,fixture(event,options));
  assert.equal(result.results[0].metadata.sourceMetadata.timestampBasis,'unknown');
  assert.equal(result.results[0].metadata.messageTimestamp,null);
  assert.equal(result.results[0].observed_at,null);
  assert.ok(result.results[0].metadata.observationWarnings.length>0);
 }
});

test('rename between search and evidence lookup returns the title and classification from one read',async()=>{
 const base=fixture(event);let searchReturned=false;let evidenceSelect;
 const fetch=async(url,options)=>{
  const parsed=new URL(url);
  if(parsed.pathname.endsWith('/rpc/search_memory_context')){
   searchReturned=true;
   return Response.json([{result_type:'excerpt',result_id:'11',event_id:42,content:'Exact retained excerpt',metadata:{conversationTitle:'Old derived prompt'}}]);
  }
  if(parsed.pathname.endsWith('/conversation_events')){
   assert.equal(searchReturned,true);evidenceSelect=parsed.searchParams.get('select');
   return Response.json([{...event,id:42,conversations:{title:'New actual provider title',source_metadata:{...source,titleBasis:'source'}}}]);
  }
  return base(url,options);
 };
 const row=(await searchMemory({...identity,query:'invented'},env,fetch)).results[0];
 assert.equal(row.metadata.conversationTitle,'New actual provider title');
 assert.equal(row.metadata.conversationSourceMetadata.titleBasis,'source');
 assert.equal(row.content,'Exact retained excerpt');
 assert.match(evidenceSelect,/conversations\(title,source_metadata\)/);
});

test('missing joined title retains the search title with unknown current classification',async()=>{
 for(const conversation of [null,{source_metadata:{...source,titleBasis:'source'}}]){
  const base=fixture(event);
  const fetch=async(url,options)=>{
   const parsed=new URL(url);
   if(parsed.pathname.endsWith('/rpc/search_memory_context'))return Response.json([{result_type:'excerpt',result_id:'11',event_id:42,content:'Exact retained excerpt',metadata:{conversationTitle:'Earlier display title'}}]);
   if(parsed.pathname.endsWith('/conversation_events'))return Response.json([{...event,id:42,conversations:conversation}]);
   return base(url,options);
  };
  const row=(await searchMemory({...identity,query:'invented'},env,fetch)).results[0];
  assert.equal(row.metadata.conversationTitle,'Earlier display title');
  assert.equal(row.metadata.conversationSourceMetadata.titleBasis,'unknown');
  assert.match(row.metadata.observationWarnings.join(' '),/title basis is unknown/i);
  assert.equal(row.content,'Exact retained excerpt');
 }
});
