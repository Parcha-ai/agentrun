import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStore } from '../dist/store/index.js';
import { createAgent, commitAgent, definitionOf } from '../dist/agents-store.js';
const native = {runtime:'codex',project:'/fixture/project',selector:{kind:'profile',name:'review'},machine_id:'test-machine',version:'0.167.2',model:null,fingerprint:'abc',configuration:[],skills:[],mcp_servers:[],state:'needs_verification',issues:[],capabilities:{launch:true,notes:true,skills:true,workflows:false,approval:'unavailable',usage:true},connected:true};
test('native binding stays in ordinary revisions through learning edits; no imported history identity', async t => {
 const data=await mkdtemp(join(tmpdir(),'agentrun-native-binding-')); const store=await openSqliteStore({dataDir:data,role:'server'});
 t.after(async()=>{await store.close();await rm(data,{recursive:true,force:true});});
 const entry=await createAgent(store,{definition:{id:'native-fixture',name:'Native fixture',instructions:'',harness:'codex',native,learning:false},skills:{}});
 assert.deepEqual(entry.revision.body.native,native);
 const edited=await commitAgent(store,entry,{definition:{instructions:'',learning:'notes'}});
 assert.deepEqual(edited.revision.body.native,native);
 assert.equal(edited.revision.body.learning,'notes');
 assert.deepEqual(definitionOf(edited.agent,edited.revision,edited.version).native,native);
 assert.equal(edited.agent.externalRef,null);
});
