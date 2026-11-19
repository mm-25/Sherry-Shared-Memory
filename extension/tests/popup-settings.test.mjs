import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../src/popup.js',import.meta.url),'utf8');
const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function popup(settings,{saveError=null,statusError=null}={}){
 const nodes=new Map();
 const document={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{checked:false,disabled:false,hidden:false,textContent:'',listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}});return nodes.get(selector);}};
 const chrome={runtime:{lastError:null,getManifest:()=>({version:'test'}),sendMessage(message,callback){
  const error=message.type==='UPDATE_SETTINGS'?saveError:statusError;
  if(error){this.lastError={message:error};callback();this.lastError=null;return;}
  if(message.type==='UPDATE_SETTINGS'){Object.assign(settings,message.payload);callback({ok:true,settings:{...settings}});return;}
  callback({ok:true,settings:{...settings},captureStats:{},ingestion:{}});
 }},tabs:{query:async()=>[{id:1,url:'https://shared-memory-ingestion.mufaddal-m25.workers.dev/'}]},permissions:{getAll:async()=>({origins:[]})}};
 vm.runInNewContext(source,{document,chrome,globalThis:{chrome},Intl,Date,URL,setTimeout});return nodes;
}
test('a failed Chromium capture-setting save is shown instead of silently reverting',async()=>{
 const settings={captureEnabled:false},nodes=popup(settings,{saveError:'Could not establish connection. Receiving end does not exist.'});await settle();
 nodes.get('#capture-enabled').checked=true;await nodes.get('#capture-enabled').listeners.change();
 assert.equal(settings.captureEnabled,false);assert.equal(nodes.get('#capture-enabled').checked,false);
 assert.equal(nodes.get('#error').hidden,false);assert.match(nodes.get('#error').textContent,/not saved|could not save/i);
});
test('a confirmed setting survives closing and reopening the popup',async()=>{
 const settings={captureEnabled:false};let nodes=popup(settings);await settle();nodes.get('#capture-enabled').checked=true;await nodes.get('#capture-enabled').listeners.change();
 nodes=popup(settings);await settle();assert.equal(nodes.get('#capture-enabled').checked,true);assert.equal(nodes.get('#capture-enabled').disabled,false);
});
test('an unavailable background does not offer an unverified capture switch',async()=>{
 const nodes=popup({captureEnabled:false},{statusError:'Could not establish connection. Receiving end does not exist.'});await settle();
 assert.equal(nodes.get('#capture-enabled').disabled,true);assert.equal(nodes.get('#error').hidden,false);
});
