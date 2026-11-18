import assert from 'node:assert/strict';
import {test} from 'node:test';
import {unlink,symlink,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeFixture} from './native-fixtures/setup.mjs';
import {serve,follow,withEnv} from "./support.mjs";

// The managed feedback loop cannot consume a native launch's steer. A grade is still useful evidence, but must not
// reopen an already completed source session into a feedback round that its dedicated runner cannot execute.
for(const runtime of ['claude-code','codex'])test(`${runtime} grades retain the completed native run without opening managed feedback`,async t=>{
 const f=await nativeFixture(t);
 const cli=fileURLToPath(new URL('./native-fixtures/feedback-cli.mjs',import.meta.url));await chmod(cli,0o755);
 for(const binary of ['claude','codex']){const path=join(f.root,'bin',binary);await unlink(path);await symlink(cli,path);}
 withEnv(t,Object.fromEntries(['PATH','HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','NATIVE_TEST_LOG'].map(key=>[key,f.env[key]])));
 const {api,store}=await serve(t);
 const connected=await api('POST','/native/connect',{project:f.project,runtime});assert.equal(connected.status,200,JSON.stringify(connected.body));
 const id=connected.body.agent.agent_id;
 assert.equal((await api('POST',`/agents/${id}/native/verify`,{})).status,200);
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:true}})).status,200);
 const started=await api('POST',`/agents/${id}/runs`,{input:{content:'Answer once from the source session.'}});assert.equal(started.status,202,JSON.stringify(started.body));
 const run=started.body.run_id;await follow(api,run,['completed']);
 const before=await store.runs.get(run),calls=await f.calls();
 const graded=await api('PUT',`/runs/${run}/grade`,{correct:false,label:'Reviewer: retain this feedback without a new source task.'});
 assert.equal(graded.status,200,JSON.stringify(graded.body));assert.equal(graded.body.feedback,null,'external native execution has no managed feedback consumer');
 assert.equal(graded.body.correct,false,'the grade remains recorded');
 const after=await store.runs.get(run);assert.deepEqual([after.state,after.endedAt,after.costUsd],[before.state,before.endedAt,before.costUsd]);
 assert.equal(await store.learning.proposal(run,2),undefined,'no stranded second learning round');
 assert.deepEqual(await f.calls(),calls,'grading dispatches no native process');
});
