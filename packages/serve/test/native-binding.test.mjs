import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStore } from '../dist/store/index.js';
import { createAgent, commitAgent, definitionOf } from '../dist/agents-store.js';
const native = {runtime:'codex',project:'/fixture/project',selector:{kind:'profile',name:'review'},machine_id:'test-machine',version:'0.167.2',model:null,fingerprint:'abc',configuration:[],skills:[],mcp_servers:[],state:'needs_verification',issues:[],capabilities:{launch:true,learning:true,workflows:false,approval:'unavailable',usage:true},connected:true};
test('native binding stays in ordinary revisions through learning edits; no imported history identity', async t => {
 const data=await mkdtemp(join(tmpdir(),'agentrun-native-binding-')); const store=await openSqliteStore({dataDir:data,role:'server'});
 t.after(async()=>{await store.close();await rm(data,{recursive:true,force:true});});
 const entry=await createAgent(store,{definition:{id:'native-fixture',name:'Native fixture',instructions:'',harness:'codex',native,learning:false},skills:{}});
 assert.deepEqual(entry.revision.body.native,native);
 const edited=await commitAgent(store,entry,{definition:{instructions:'',learning:true}});
 assert.deepEqual(edited.revision.body.native,native);
 assert.equal(edited.revision.body.learning,true);
 assert.deepEqual(definitionOf(edited.agent,edited.revision,edited.version).native,native);
 assert.equal(edited.agent.externalRef,null);
});

test('native revisions reject a coerced remote target id while retaining the same opaque string', async t => {
 const data=await mkdtemp(join(tmpdir(),'agentrun-native-binding-')); const store=await openSqliteStore({dataDir:data,role:'server'});
 t.after(async()=>{await store.close();await rm(data,{recursive:true,force:true});});
 const remote={connector_id:`rc_${'a'.repeat(32)}`,target_id:123};
 const definition={id:'remote-target',name:'Remote target',instructions:'',harness:'codex',native:{...native,remote},learning:false};
 await assert.rejects(createAgent(store,{definition,skills:{}}),/Invalid remote native reference/);
 assert.equal(await store.agents.get(definition.id),undefined,'invalid metadata must not create an agent');
 const entry=await createAgent(store,{definition:{...definition,native:{...native,remote:{...remote,target_id:'123'}}},skills:{}});
 assert.deepEqual(entry.revision.body.native,{...native,remote:{...remote,target_id:'123'}});
 assert.deepEqual(definitionOf(entry.agent,entry.revision,entry.version).native.remote,{...remote,target_id:'123'});
});
