import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseCodexJsonl } from '../codex.js';
import { parseAntigravityTranscript } from '../antigravity.js';
import { parseClaudeAxSnapshot, createClaudeDesktopBatches } from '../claude-desktop.js';
import { collectCodexChanges } from '../collector.js';
import { collectAntigravityChanges } from '../antigravity-collector.js';
import { EncryptedStateStore } from '../state.js';
const id = 'a73cd68b-bd48-46ea-a2fe-b61238d23d09';
const workspaceId = 'f240c121-52d7-45dd-a2d3-8c4743e77955';
const at = '2026-10-01T12:00:01.000Z';
const row = (type,payload,timestamp=at) => JSON.stringify({type,payload,timestamp});
const source = (timestamp=at,pass={}) => [row('session_meta',{id,thread_source:'user',source:'vscode'}),row('response_item',{
 type:'message',id:'u1',role:'user',content:[{type:'input_text',text:'Prompt display fallback'}],
 internal_chat_message_metadata_passthrough:{content_item_kinds:['user.text'],...pass}},timestamp)].join('\n');
async function fixture(t) {
 const home=await mkdtemp(join(tmpdir(),'sherry-metadata-')); t.after(()=>rm(home,{recursive:true,force:true}));
 const sessionsDir=join(home,'sessions'); await mkdir(sessionsDir);
 const filename=join(sessionsDir,`rollout-${id}.jsonl`); await writeFile(filename,source());
 const store=new EncryptedStateStore(join(home,'state'),Buffer.alloc(32,7));
 return {home,sessionsDir,filename,store,state:await store.load()};
}
const sql = (v) => `'${v.replaceAll("'","''")}'`;
function codexDb(home,filename,title,name='') {
 execFileSync('/usr/bin/sqlite3',[join(home,'state_5.sqlite'),`CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,rollout_path TEXT,title TEXT,name TEXT,first_user_message TEXT); INSERT OR REPLACE INTO threads VALUES('${id}',${sql(filename)},${sql(title)},${sql(name)},'Prompt display fallback');`]);
}
test('Codex derived title and log-position identity never imply provider metadata',()=>{
 const parsed=parseCodexJsonl(source());const e=parsed.events[0];
 assert.deepEqual(e.sourceMetadata,{version:1,titleBasis:'derived',conversationIdentity:'provider',messageIdentity:'provider',timestampBasis:'source',linksStatus:'not_inspected',attachmentsStatus:'not_inspected'});
 const noId=source().replace('"id":"u1",','');
 assert.equal(parseCodexJsonl(noId).events[0].sourceMetadata.messageIdentity,'local');
});
test('Codex session fallback remains explicitly session time and valid passthrough beats invalid row time',()=>{
 const fallback=parseCodexJsonl(source(null)).events[0];
 assert.equal(fallback.messageTimestamp,at);assert.equal(fallback.sourceMetadata.timestampBasis,'session_fallback');
 const original=parseCodexJsonl(source('invalid',{create_time:'2026-10-01T12:01:00.000Z'})).events[0];
 assert.equal(original.messageTimestamp,'2026-10-01T12:01:00.000Z');assert.equal(original.sourceMetadata.timestampBasis,'source');
});
test('Codex exact source ID and file mapping use native name without collector prompt override',async(t)=>{
 const f=await fixture(t);codexDb(f.home,f.filename,'Stored generated title','Renamed native title');
 const options={sessionsDir:f.sessionsDir,workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1}};
 assert.equal((await collectCodexChanges(f.state,f.store,options)).addedEvents,1);
 const before=structuredClone(f.state.pending[0].batch);const e=before.events[0];
 assert.equal(e.chatTitle,'Renamed native title');assert.equal(e.sourceMetadata.titleBasis,'source');assert.equal(e.conversationId,id);
 codexDb(f.home,f.filename,'Stored generated title','A title-only rename');
 assert.equal((await collectCodexChanges(f.state,f.store,options)).addedEvents,0);
 assert.deepEqual(f.state.pending[0].batch,before);assert.equal(f.state.pending.length,1);
});
test('Codex unrelated file metadata is ignored and pre-enable prompt stays private',async(t)=>{
 const f=await fixture(t);codexDb(f.home,join(f.home,'other.jsonl'),'Wrong chat title','Wrong native name');
 const privateRow=row('response_item',{type:'message',id:'old',role:'user',content:[{type:'input_text',text:'Earlier private prompt'}],internal_chat_message_metadata_passthrough:{content_item_kinds:['user.text']}},'2026-09-01T00:00:00Z');
 await writeFile(f.filename,[row('session_meta',{id,thread_source:'user',source:'vscode'}),privateRow,source().split('\n')[1]].join('\n'));
 await collectCodexChanges(f.state,f.store,{sessionsDir:f.sessionsDir,workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1}});
 const e=f.state.pending[0].batch.events[0];assert.equal(e.chatTitle,'Prompt display fallback');assert.equal(e.sourceMetadata.titleBasis,'derived');
 assert.ok(!JSON.stringify(f.state.pending).includes('Earlier private prompt'));
});
test('Antigravity source table title survives collector with folder and step identities unchanged',async(t)=>{
 const f=await fixture(t);const root=join(f.home,'brain');const logs=join(root,id,'.system_generated','logs');await mkdir(logs,{recursive:true});
 const raw=JSON.stringify({step_index:1,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',created_at:at,content:'Prompt display fallback'});
 await writeFile(join(logs,'transcript.jsonl'),raw);
 execFileSync('/usr/bin/sqlite3',[join(f.home,'conversation_summaries.db'),`CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT); INSERT INTO conversation_summaries VALUES('${id}','Native Antigravity title');`]);
 await collectAntigravityChanges(f.state,f.store,{root,workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1}});
 const e=f.state.pending[0].batch.events[0];assert.equal(e.chatTitle,'Native Antigravity title');assert.equal(e.sourceMetadata.titleBasis,'source');assert.equal(e.sourceMetadata.messageIdentity,'local');assert.equal(e.conversationId,id);assert.equal(e.providerMessageId,'1:user');
 assert.equal(parseAntigravityTranscript(raw,id).events[0].sourceMetadata.titleBasis,'derived');
});
test('Claude AX titles retain unknown evidence and existing desktop identity',()=>{
 for(const title of ['Claude','Ordinary-looking AX page title']) {
  const parsed=parseClaudeAxSnapshot({kind:'claude_ax_snapshot_v1',sourceURL:`app://localhost/chat/${id}`,title,truncated:false,turns:[{role:'user',text:'Prompt'}]});
  const e=createClaudeDesktopBatches({...parsed,localConversationId:id},{workspaceId,deviceId:'device_test12345',capturedAt:at,serverCapabilities:{sourceMetadataVersion:1}})[0].events[0];
  assert.equal(e.sourceMetadata.titleBasis,title==='Claude'?'generic':'unknown');assert.equal(e.sourceMetadata.conversationIdentity,'local');assert.equal(e.sourceMetadata.messageIdentity,'local');assert.equal(e.sourceMetadata.timestampBasis,'observed');assert.equal(e.messageTimestamp,null);assert.equal(e.conversationId,`desktop:${id}`);
 }
});

test('new evidence stays off for unconfirmed servers while capable batches retain it',async(t)=>{
 const legacy=await fixture(t);const modern=await fixture(t);
 const options={workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at};
 await collectCodexChanges(legacy.state,legacy.store,{...options,sessionsDir:legacy.sessionsDir});
 await collectCodexChanges(modern.state,modern.store,{...options,sessionsDir:modern.sessionsDir,serverCapabilities:{sourceMetadataVersion:1}});
 assert.equal(legacy.state.pending[0].batch.events[0].sourceMetadata,undefined);
 assert.equal(modern.state.pending[0].batch.events[0].sourceMetadata.titleBasis,'derived');
});
for(const provider of ['codex','antigravity']) test(`${provider} title-only update survives encrypted restart without a fake message or queue rewrite`,async(t)=>{
 const f=await fixture(t);const root=join(f.home,'brain');
 const database=provider==='codex'?join(f.home,'state_5.sqlite'):join(f.home,'conversation_summaries.db');
 if(provider==='codex') codexDb(f.home,f.filename,'Initial source title');
 else {
  const logs=join(root,id,'.system_generated','logs');await mkdir(logs,{recursive:true});
  await writeFile(join(logs,'transcript.jsonl'),JSON.stringify({step_index:1,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',created_at:at,content:'Prompt display fallback'}));
  execFileSync('/usr/bin/sqlite3',[database,`CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT); INSERT INTO conversation_summaries VALUES('${id}','Initial source title');`]);
 }
 const options={workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1,conversationUpdatesVersion:1}};
 const collect=()=>provider==='codex'?collectCodexChanges(f.state,f.store,{...options,sessionsDir:f.sessionsDir}):collectAntigravityChanges(f.state,f.store,{...options,root});
 assert.equal((await collect()).addedEvents,1);const frozen=structuredClone(f.state.pending[0].batch);const observed=f.state.lastCaptureAt;
 execFileSync('/usr/bin/sqlite3',[database,`UPDATE ${provider==='codex'?'threads':'conversation_summaries'} SET title='Renamed without new text'`]);
 f.state=await f.store.load();
 const renamed=await collect();assert.equal(renamed.addedEvents,0);assert.equal(renamed.addedUpdates,1);
 assert.deepEqual(f.state.pending[0].batch,frozen);assert.equal(f.state.lastCaptureAt,observed);
 const batch=f.state.pending[1].batch;assert.deepEqual(batch.events,[]);assert.equal(batch.conversationUpdates.length,1);
 assert.equal(batch.conversationUpdates[0].conversationId,id);assert.equal(batch.conversationUpdates[0].chatTitle,'Renamed without new text');
 assert.deepEqual(batch.conversationUpdates[0].sourceMetadata,{version:1,titleBasis:'source',conversationIdentity:'provider',messageIdentity:'unknown',timestampBasis:'unknown',linksStatus:'unknown',attachmentsStatus:'unknown'});
 f.state=await f.store.load();assert.equal((await collect()).addedUpdates,0);assert.equal(f.state.pending.length,2);
});

test('a rename seen while capabilities are absent retries when support returns',async(t)=>{
 const f=await fixture(t);codexDb(f.home,f.filename,'Initial source title');
 const options={sessionsDir:f.sessionsDir,workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1,conversationUpdatesVersion:1}};
 await collectCodexChanges(f.state,f.store,options);
 codexDb(f.home,f.filename,'Rename during temporary capability failure');
 assert.equal((await collectCodexChanges(f.state,f.store,{...options,serverCapabilities:{}})).addedUpdates,0);
 assert.equal((await collectCodexChanges(f.state,f.store,options)).addedUpdates,1);
});
test('queue pressure and a mid-scan pause retain a pending title change for retry',async(t)=>{
 const f=await fixture(t);codexDb(f.home,f.filename,'Initial source title');
 const options={sessionsDir:f.sessionsDir,workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1,conversationUpdatesVersion:1}};
 await collectCodexChanges(f.state,f.store,options);codexDb(f.home,f.filename,'Retriable renamed source title');
 assert.equal((await collectCodexChanges(f.state,f.store,{...options,maxPendingBatches:1})).queueFull,true);
 let checks=0;const paused=await collectCodexChanges(f.state,f.store,{...options,isEnabled:async()=>++checks<3});
 assert.equal(paused.addedUpdates,0);assert.equal(f.state.pending.length,1);
 assert.equal((await collectCodexChanges(f.state,f.store,options)).addedUpdates,1);
});
test('capability detection requires advertised versions, expires and preserves legacy fallback',async()=>{
 const {captureServerCapabilities}=await import('../source-metadata.js');let calls=0;
 const fetchImpl=async(url)=>{assert.equal(url,'https://metadata-capabilities.example.org/health');calls++;return {ok:true,json:async()=>({ok:true,sourceMetadataVersion:1,conversationUpdatesVersion:1})};};
 const endpoint='https://metadata-capabilities.example.org/v1/capture/batches';
 assert.deepEqual(await captureServerCapabilities(endpoint,{fetchImpl,now:()=>1000}),{sourceMetadataVersion:1,conversationUpdatesVersion:1});
 await captureServerCapabilities(endpoint,{fetchImpl,now:()=>2000});assert.equal(calls,1);
 assert.deepEqual(await captureServerCapabilities(endpoint,{fetchImpl:async()=>{throw Error('offline');},now:()=>62000}),{});
 assert.deepEqual(await captureServerCapabilities('https://legacy-capabilities.example.org',{fetchImpl:async()=>({ok:true,json:async()=>({ok:true})})}),{});
});

test('metadata-only delivery waits for complete receipt and replays exact encrypted bytes',async(t)=>{
 const f=await fixture(t);codexDb(f.home,f.filename,'Initial source title');
 const options={sessionsDir:f.sessionsDir,workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1,conversationUpdatesVersion:1}};
 await collectCodexChanges(f.state,f.store,options);codexDb(f.home,f.filename,'Rename to upload');
 await collectCodexChanges(f.state,f.store,options);
 const {uploadPending}=await import('../uploader.js');const sent=[];let rejectMetadataReceipt=true;
 const fetchImpl=async(_url,request)=>{
  if(new URL(_url).pathname==='/health')return {ok:true,json:async()=>({ok:true,sourceMetadataVersion:1,conversationUpdatesVersion:1})};
  const batch=JSON.parse(request.body);sent.push(request.body);
  const metadata=batch.conversationUpdates?.length||0;
  return {ok:true,status:200,json:async()=>({ok:true,batchId:batch.batchId,result:{status:'committed',received:batch.events.length,inserted:batch.events.length,updated:0,duplicates:0,
   ...(metadata&&!rejectMetadataReceipt?{metadataReceived:metadata,metadataUpdated:1}:{})}})};
 };
 const delivery={endpoint:'https://example.org',accessToken:'invented-token',fetchImpl,now:()=>new Date('2026-10-01T12:05:00Z')};
 const first=await uploadPending(f.state,f.store,delivery);assert.equal(first.status,'retry');assert.equal(first.uploaded,1);
 f.state=await f.store.load();assert.equal(f.state.pending.length,1);const frozen=JSON.stringify(f.state.pending[0].batch);
 rejectMetadataReceipt=false;const second=await uploadPending(f.state,f.store,{...delivery,now:()=>new Date('2026-10-01T12:06:00Z')});
 assert.equal(second.uploaded,1);assert.equal(sent[1],frozen);assert.equal(sent[2],frozen);assert.equal(f.state.pending.length,0);
});

for (const provider of ['codex','antigravity']) test(`${provider} known title rename after resume does not require a post-cutoff message`,async(t)=>{
 const f=await fixture(t);const root=join(f.home,'brain');
 const database=provider==='codex'?join(f.home,'state_5.sqlite'):join(f.home,'conversation_summaries.db');
 if(provider==='codex') codexDb(f.home,f.filename,'Before resume');
 else {
  const logs=join(root,id,'.system_generated','logs');await mkdir(logs,{recursive:true});
  await writeFile(join(logs,'transcript.jsonl'),JSON.stringify({step_index:1,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',created_at:at,content:'Before resume prompt'}));
  execFileSync('/usr/bin/sqlite3',[database,`CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT); INSERT INTO conversation_summaries VALUES('${id}','Before resume');`]);
 }
 const options={workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1,conversationUpdatesVersion:1}};
 const collect=(extra={})=>provider==='codex'?collectCodexChanges(f.state,f.store,{...options,...extra,sessionsDir:f.sessionsDir}):collectAntigravityChanges(f.state,f.store,{...options,...extra,root});
 assert.equal((await collect()).addedEvents,1);const frozen=JSON.stringify(f.state.pending[0].batch);const seen=structuredClone(f.state.seen);const lastCapture=f.state.lastCaptureAt;
 execFileSync('/usr/bin/sqlite3',[database,`UPDATE ${provider==='codex'?'threads':'conversation_summaries'} SET title='Renamed after resume'`]);
 f.state=await f.store.load();const resumed={captureFrom:'2026-10-01T12:10:00.000Z',now:()=> '2026-10-01T12:11:00.000Z'};
 const result=await collect(resumed);assert.equal(result.addedEvents,0);assert.equal(result.addedUpdates,1);
 assert.equal(JSON.stringify(f.state.pending[0].batch),frozen);assert.deepEqual(f.state.seen,seen);assert.equal(f.state.lastCaptureAt,lastCapture);
 const update=f.state.pending[1].batch;assert.deepEqual(update.events,[]);assert.equal(update.conversationUpdates[0].conversationId,id);assert.equal(update.conversationUpdates[0].chatTitle,'Renamed after resume');
 f.state=await f.store.load();assert.equal((await collect(resumed)).addedUpdates,0);
 // The same source without a proven registry may not promote uncaptured history.
 f.state.conversationMetadata={};f.state.metadataFingerprints={};f.state.pending=[];
 execFileSync('/usr/bin/sqlite3',[database,`UPDATE ${provider==='codex'?'threads':'conversation_summaries'} SET title='Unknown history rename'`]);
 const unknown=await collect(resumed);assert.equal(unknown.addedEvents,0);assert.equal(unknown.addedUpdates,0);assert.equal(f.state.pending.length,0);
});

for (const {stored,name,want,basis} of [
 {stored:'Prompt display fallback',name:'',want:'Prompt display fallback',basis:'derived'},
 {stored:'Prompt display fallback',name:'Explicit native name',want:'Explicit native name',basis:'source'},
 {stored:'Generated native title',name:'',want:'Generated native title',basis:'source'}
]) test(`Codex continuation preserves ${basis} native title ${want} without capturing its older prompt`,async(t)=>{
 const f=await fixture(t);codexDb(f.home,f.filename,stored,name);
 const later='2026-10-01T12:10:00.000Z';
 const followup=row('response_item',{type:'message',id:'u2',role:'user',content:[{type:'input_text',text:'Later unrelated follow-up'}],internal_chat_message_metadata_passthrough:{content_item_kinds:['user.text']}},later);
 await writeFile(f.filename,source()+'\n'+followup);
 const options={sessionsDir:f.sessionsDir,workspaceId,deviceId:'device_test12345',captureFrom:later,now:()=>later,serverCapabilities:{sourceMetadataVersion:1,conversationUpdatesVersion:1}};
 const result=await collectCodexChanges(f.state,f.store,options);assert.equal(result.addedEvents,1);
 const batch=f.state.pending[0].batch;assert.deepEqual(batch.events.map(e=>e.text),['Later unrelated follow-up']);
 const event=batch.events[0];assert.equal(event.chatTitle,want);assert.equal(event.sourceMetadata.titleBasis,basis);assert.equal(event.conversationId,id);assert.equal(event.providerMessageId,'u2');assert.equal(event.messageTimestamp,later);
 const frozen=JSON.stringify(batch);f.state=await f.store.load();assert.equal((await collectCodexChanges(f.state,f.store,options)).addedEvents,0);assert.equal(JSON.stringify(f.state.pending[0].batch),frozen);
});
test('Codex title-only rename back to the original prompt preserves derived provenance after resume',async(t)=>{
 const f=await fixture(t);codexDb(f.home,f.filename,'Independent native title');
 const options={sessionsDir:f.sessionsDir,workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1,conversationUpdatesVersion:1}};
 await collectCodexChanges(f.state,f.store,options);const frozen=JSON.stringify(f.state.pending[0].batch);const seen=structuredClone(f.state.seen);
 codexDb(f.home,f.filename,'Prompt display fallback');
 const result=await collectCodexChanges(f.state,f.store,{...options,captureFrom:'2026-10-01T12:10:00.000Z',now:()=> '2026-10-01T12:11:00.000Z'});
 assert.equal(result.addedEvents,0);assert.equal(result.addedUpdates,1);
 const batch=f.state.pending[1].batch;assert.deepEqual(batch.events,[]);assert.equal(batch.conversationUpdates[0].chatTitle,'Prompt display fallback');assert.equal(batch.conversationUpdates[0].sourceMetadata.titleBasis,'derived');assert.equal(batch.conversationUpdates[0].conversationId,id);
 assert.equal(JSON.stringify(f.state.pending[0].batch),frozen);assert.deepEqual(f.state.seen,seen);assert.equal(f.state.lastCaptureAt,at);
});

for(const kind of ['sourceMetadata','conversationUpdates']) test(`frozen ${kind} waits through rollback and encrypted restart before exact delivery`,async(t)=>{
 const f=await fixture(t);codexDb(f.home,f.filename,'Initial source title');
 const options={sessionsDir:f.sessionsDir,workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1,conversationUpdatesVersion:1}};
 await collectCodexChanges(f.state,f.store,options);
 if(kind==='conversationUpdates') {
  codexDb(f.home,f.filename,'Renamed title');await collectCodexChanges(f.state,f.store,options);
  f.state.pending=[f.state.pending[1]];await f.store.save(f.state);
 }
 const frozen=JSON.stringify(f.state.pending[0].batch);const calls=[];let caps={ok:true};
 const {uploadPending}=await import('../uploader.js');
 const fetchImpl=async(url,request)=>{
  calls.push({path:new URL(url).pathname,method:request?.method||'GET'});
  if(new URL(url).pathname==='/health')return {ok:true,json:async()=>caps};
  assert.equal(request.body,frozen);const batch=JSON.parse(request.body);return {ok:true,status:200,json:async()=>({ok:true,batchId:batch.batchId,result:{status:'committed',received:batch.events.length,inserted:batch.events.length,updated:0,duplicates:0,...(batch.conversationUpdates?{metadataReceived:1,metadataUpdated:1}:{})}})};
 };
 const endpoint=`https://frozen-${kind.toLowerCase()}.example.org`;
 const delivery={endpoint,accessToken:'invented-token',fetchImpl,now:()=>new Date('2026-10-01T12:05:00Z')};
 const legacy=await uploadPending(f.state,f.store,delivery);assert.equal(legacy.uploaded,0);assert.equal(legacy.status,'retry');assert.equal(f.state.pending.length,1);assert.equal(JSON.stringify(f.state.pending[0].batch),frozen);assert.match(f.state.lastError,/metadata/i);assert.deepEqual(calls,[{path:'/health',method:'GET'}]);
 f.state=await f.store.load();caps={ok:true,sourceMetadataVersion:1};
 const partial=await uploadPending(f.state,f.store,{...delivery,now:()=>new Date('2026-10-01T12:06:00Z')});
 if(kind==='conversationUpdates') {
  assert.equal(partial.uploaded,0);assert.equal(f.state.pending.length,1);caps={...caps,conversationUpdatesVersion:1};f.state=await f.store.load();
  assert.equal((await uploadPending(f.state,f.store,{...delivery,now:()=>new Date('2026-10-01T12:08:00Z')})).uploaded,1);
 } else assert.equal(partial.uploaded,1);
 assert.equal(f.state.pending.length,0);assert.equal(calls.filter(c=>c.method==='POST').length,1);
 // A new frozen capable request must not trust an earlier upload's positive cache.
 f.state.pending=[{batch:JSON.parse(frozen),attempts:0,nextAttemptAt:null}];caps={ok:true};calls.length=0;
 assert.equal((await uploadPending(f.state,f.store,{...delivery,now:()=>new Date('2026-10-01T12:08:01Z')})).uploaded,0);
 assert.deepEqual(calls,[{path:'/health',method:'GET'}]);assert.equal(JSON.stringify(f.state.pending[0].batch),frozen);
});
test('legacy frozen batches require no newly advertised capability at send time',async(t)=>{
 const f=await fixture(t);await collectCodexChanges(f.state,f.store,{sessionsDir:f.sessionsDir,workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at});
 const frozen=JSON.stringify(f.state.pending[0].batch);const {uploadPending}=await import('../uploader.js');const calls=[];
 const result=await uploadPending(f.state,f.store,{endpoint:'https://legacy-frozen.example.org',accessToken:'invented-token',fetchImpl:async(url,request)=>{
  calls.push(new URL(url).pathname);assert.equal(request.method,'POST');assert.equal(request.body,frozen);const batch=JSON.parse(request.body);
  return {ok:true,status:200,json:async()=>({ok:true,batchId:batch.batchId,result:{status:'committed',received:1,inserted:1,updated:0,duplicates:0}})};
 }});
 assert.equal(result.uploaded,1);assert.deepEqual(calls,['/v1/capture/batches']);
});
test('failed send-time health retains the frozen request and a pause stops POST after health',async(t)=>{
 const f=await fixture(t);await collectCodexChanges(f.state,f.store,{sessionsDir:f.sessionsDir,workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1}});
 const frozen=JSON.stringify(f.state.pending[0].batch);const {uploadPending}=await import('../uploader.js');let posts=0;
 const failed=await uploadPending(f.state,f.store,{endpoint:'https://offline-frozen.example.org',accessToken:'invented-token',now:()=>new Date('2026-10-01T12:05:00Z'),fetchImpl:async(url)=>{
  if(new URL(url).pathname==='/health')throw Error('offline');posts++;throw Error('POST must not happen');
 }});
 assert.equal(failed.status,'retry');assert.equal(posts,0);assert.equal(JSON.stringify(f.state.pending[0].batch),frozen);
 let enabled=true;
 const paused=await uploadPending(f.state,f.store,{endpoint:'https://paused-frozen.example.org',accessToken:'invented-token',now:()=>new Date('2026-10-01T12:06:00Z'),isEnabled:async()=>enabled,fetchImpl:async(url)=>{
  assert.equal(new URL(url).pathname,'/health');enabled=false;return {ok:true,json:async()=>({ok:true,sourceMetadataVersion:1})};
 }});
 assert.equal(paused.status,'paused');assert.equal(JSON.stringify(f.state.pending[0].batch),frozen);
});

test('send-time health is reused within a run and expires before later frozen batches',async(t)=>{
 const f=await fixture(t);await collectCodexChanges(f.state,f.store,{sessionsDir:f.sessionsDir,workspaceId,deviceId:'device_test12345',captureFrom:at,now:()=>at,serverCapabilities:{sourceMetadataVersion:1}});
 const {stableUuid}=await import('../batches.js');const batch=f.state.pending[0].batch;
 f.state.pending=[0,1,2].map(i=>({batch:{...structuredClone(batch),batchId:stableUuid(`bounded-health-${i}`)},attempts:0,nextAttemptAt:null}));
 const original=f.state.pending.map(item=>JSON.stringify(item.batch));const {uploadPending}=await import('../uploader.js');let time=Date.parse('2026-10-01T12:05:00Z'),probes=0,posts=0;
 const result=await uploadPending(f.state,f.store,{endpoint:'https://bounded-frozen.example.org',accessToken:'invented-token',now:()=>new Date(time),fetchImpl:async(url,request)=>{
  if(new URL(url).pathname==='/health'){probes++;return {ok:true,json:async()=>({ok:true,sourceMetadataVersion:1})};}
  assert.equal(request.body,original[posts]);const sent=JSON.parse(request.body);posts++;time+=posts===1?30000:31000;
  return {ok:true,status:200,json:async()=>({ok:true,batchId:sent.batchId,result:{status:'committed',received:1,inserted:1,updated:0,duplicates:0}})};
 }});
 assert.equal(result.uploaded,3);assert.equal(posts,3);assert.equal(probes,2);assert.equal(f.state.pending.length,0);
});
