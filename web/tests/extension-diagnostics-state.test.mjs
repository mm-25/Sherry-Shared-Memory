import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('function renderExtensionDiagnostics('),source.indexOf('function renderExtensionStatus('));
function render(bridgePresent){
 const nodes=new Map(),make=()=>({textContent:'',className:'',children:[],append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;}});
 const $=id=>{if(!nodes.has(id))nodes.set(id,make());return nodes.get(id);};
 const document={getElementById:id=>id==='sherry-capture-bridge'?(bridgePresent?{}:null):$(id),createElement:make};
 vm.runInNewContext(`${fn}\nrenderExtensionDiagnostics(null,'Could not establish connection. Receiving end does not exist.');`,{document,$});return nodes;
}
test('Diagnostics distinguishes a present connector from a missing background reply',()=>{
 const nodes=render(true);assert.match(nodes.get('diagnosticsExtensionState').textContent,/connector present|not responding|connection unavailable/i);
 const text=nodes.get('diagnosticsExtensionEvents').children[0].children.map(x=>x.textContent).join(' ');assert.match(text,/connector|background/i);
});
