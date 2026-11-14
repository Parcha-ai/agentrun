import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from './support.mjs';
test('connect existing project is idempotent and normal learning edits retain its native reference', async t=>{
 const project=await mkdtemp(join(tmpdir(),'agentrun-native-api-')); t.after(()=>rm(project,{recursive:true,force:true}));
 await writeFile(join(project,'AGENTS.md'),'Keep the original project instructions.\n');
 const {api}=await serve(t,{runner:false});
 const connect=()=>api('POST','/native/connect',{project,runtime:'codex',selector:{kind:'project'}});
 const first=await connect(); assert.equal(first.status,200,JSON.stringify(first.body));
 const id=first.body.agent.agent_id;
 const connectedRevision=first.body.agent.revision;assert.equal(typeof connectedRevision,'string');
 assert.equal((await connect()).body.agent.agent_id,id);
 const edited=await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:'notes'}});
 assert.equal(edited.status,200,JSON.stringify(edited.body));
 assert.equal(edited.body.definition.native.project,project);
 assert.equal(edited.body.definition.learning,'notes');
 const unchanged={...edited.body.definition.native,selector:{...edited.body.definition.native.selector}};
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',native:Object.fromEntries(Object.entries(unchanged).reverse())}})).status,200,'native equality is semantic, not object key order');
 assert.equal((await api('POST','/agents',{definition:{id:'forged',instructions:'',native:unchanged}})).status,422,'generic create cannot introduce a native host binding');
 assert.equal((await api('POST','/runs',{external:{source:'fixture',kind:'native',id:'forged',version:1},definition:{instructions:'',native:unchanged},input:{content:'No native dispatch.'}})).status,422,'inline definition cannot bypass native registration');
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',native:{...unchanged,project:'/another/source'}}})).status,422);
 for(const extra of [{effort:'high'},{file_ids:['file-native-not-copied']}])assert.equal((await api('POST',`/agents/${id}/runs`,{input:{content:'No ignored native controls.'},...extra})).status,422);
 assert.equal((await api('POST',`/agents/${id}/native/disconnect`,{})).body.native.connected,false);
 assert.equal((await api('POST',`/agents/${id}/current`,{revision:connectedRevision})).status,422,'ordinary revision restore cannot undo disconnect');
 assert.equal((await api('POST',`/agents/${id}/runs`,{revision:connectedRevision,input:{content:'Old revision cannot reconnect.'}})).status,409);
 const refused=await api('POST',`/agents/${id}/runs`,{input:{content:'Do not run disconnected.'}});
 assert.equal(refused.status,409,JSON.stringify(refused.body));
 assert.equal(await readFile(join(project,'AGENTS.md'),'utf8'),'Keep the original project instructions.\n');
});

test('native source discovery rejects invalid directories and hosted servers explicitly',async t=>{
 const local=await serve(t,{runner:false});assert.equal((await local.api('POST','/native/discover',{project:'/missing/agentrun-native-project'})).status,422);
 const hosted=await serve(t,{runner:false,publicUrl:'https://example.test'});assert.equal((await hosted.api('POST','/native/discover',{project:'/tmp'})).status,403);
});
