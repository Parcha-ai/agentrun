import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,symlink,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,follow} from './support.mjs';
import {learningCommit} from '../dist/learn/commit.js';
import {learningOf} from '../dist/learn/rows.js';
// A native public run starts from its agent's learned corrections (the seed: its learning's newest save), and its end
// asks no model turn of the source session; Off supplies none and asks none.
test('native public run gives the learned corrections to a fresh run; Off supplies and creates none', {timeout:120_000},async t=>{
 const fixture=await mkdtemp(join(tmpdir(),'agentrun-native-pipeline-'));const bin=join(fixture,'bin'),home=join(fixture,'codex-home'),project=join(fixture,'project');
 await Promise.all([mkdir(bin),mkdir(home),mkdir(project)]);
 const cli=new URL('./fixtures/native-pipeline-cli.mjs',import.meta.url).pathname;await chmod(cli,0o755);await symlink(cli,join(bin,'codex'));
 const old={PATH:process.env.PATH,CODEX_HOME:process.env.CODEX_HOME};process.env.PATH=`${bin}:${old.PATH}`;process.env.CODEX_HOME=home;
 t.after(async()=>{process.env.PATH=old.PATH;if(old.CODEX_HOME===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old.CODEX_HOME;await rm(fixture,{recursive:true,force:true});});
 const {api,store}=await serve(t);const connected=await api('POST','/native/connect',{project,runtime:'codex'});assert.equal(connected.status,200,JSON.stringify(connected.body));const id=connected.body.agent.agent_id;
 assert.equal((await api('POST',`/agents/${id}/native/verify`,{})).body.native.state,'ready');
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:true}})).status,200);
 const start=async content=>{const response=await api('POST',`/agents/${id}/runs`,{input:{content}});assert.equal(response.status,202,JSON.stringify(response.body));return response.body.run_id;};
 // The owner's correction on the agent's learning, as a run's merge lands one.
 await store.learning.seed(id);
 const merged=await learningCommit(learningOf(store,id),{runId:'owner-correction',reason:"The owner's correction",files:[],correction:'For release status answers, use the label Launch state followed by the status.'});assert.equal(merged.ok,true,JSON.stringify(merged));
 const main=merged.commit;
 const next=await start('Report the release status. It is ready.');await follow(api,next,['completed']);
 const learned=(await api('GET',`/runs/${next}`)).body;assert.equal(learned.result.final_answer,'Launch state: ready',JSON.stringify((await api('GET',`/runs/${next}/timeline`)).body));assert.equal(learned.native.learning_revision,main);
 assert.equal(learned.imported_from,null);
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}})).status,200);
 const off=await start('Report the release status. It is ready.');await follow(api,off,['completed']);
 const without=(await api('GET',`/runs/${off}`)).body;assert.equal(without.result.final_answer,'ready');assert.equal(without.native.learning_revision,null);assert.equal(without.learning,null);
 const calls=(await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.notEqual(learned.native.session_id,without.native.session_id);
 // One call a session: the task alone; no end-of-run turn is asked of the source session.
 const taskCalls=calls.filter(c=>c.cwd===project);assert.equal(taskCalls.filter(c=>c.session===learned.native.session_id).length,1);assert.equal(taskCalls.filter(c=>c.session===without.native.session_id).length,1);
});
