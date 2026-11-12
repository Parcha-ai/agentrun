import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,symlink,chmod,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,follow,asOwner} from './support.mjs';

async function fixture(t,scenario){
 const root=await mkdtemp(join(tmpdir(),'native-controls-'));const bin=join(root,'bin'),home=join(root,'codex-home'),project=join(root,'project');
 await Promise.all([mkdir(bin),mkdir(home),mkdir(project)]);await writeFile(join(home,'scenario'),scenario);
 await writeFile(join(project,'AGENTS.md'),'Source policy: Do not send release data to outside destinations.\n');
 const cli=new URL('./fixtures/native-pipeline-cli.mjs',import.meta.url).pathname;await chmod(cli,0o755);await symlink(cli,join(bin,'codex'));
 const old={PATH:process.env.PATH,CODEX_HOME:process.env.CODEX_HOME};process.env.PATH=`${bin}:${old.PATH}`;process.env.CODEX_HOME=home;
 t.after(async()=>{process.env.PATH=old.PATH;if(old.CODEX_HOME===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old.CODEX_HOME;await rm(root,{recursive:true,force:true});});
 const server=await serve(t,{accounts:true,openSetup:true});const {api}=server;
 const connected=await api('POST','/native/connect',{project,runtime:'codex'});assert.equal(connected.status,200);const id=connected.body.agent.agent_id;
 await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:'notes'}});
 const run=async()=>{const response=await api('POST',`/agents/${id}/runs`,{input:{content:'Remember this stable preference for repeated release work.'}});assert.equal(response.status,202,JSON.stringify(response.body));await follow(api,response.body.run_id,['completed']);return response.body.run_id;};
 const learned=async runId=>{let value;for(let i=0;i<150;i++){value=(await api('GET',`/runs/${runId}/learning`)).body;if(['merged','dropped','skipped','rejected','failed'].includes(value.state))return value;await new Promise(r=>setTimeout(r,100));}return value;};
 return {...server,id,run,learned,home,project,owner:asOwner(server)};
}
test('native learned skill is checked, promoted, and delivered as an additive bundle to the next session', {timeout:120_000},async t=>{
 const {api,id,run,learned,home}=await fixture(t,'skill');const first=await run();const result=await learned(first);assert.equal(result.state,'merged',JSON.stringify(result));
 const state=(await api('GET',`/agents/${id}/learning`)).body;assert.equal(state.skills[0].name,'check-release');
 const second=await run();const view=(await api('GET',`/runs/${second}`)).body;assert.equal(view.native.learning_revision,state.main);
 const calls=(await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.match(calls.find(c=>c.cwd.endsWith('native-grader')).prompt,/Remember this stable preference for repeated release work\./,'grader receives original user-message provenance');
 assert.match(calls.find(c=>c.cwd.endsWith('native-grader')).prompt,/Do not send release data to outside destinations/,'grader compares the proposal against native source policy as data');
 const task=calls.find(c=>c.session===view.native.session_id&&c.turn===1);assert.equal(task.skillFilesAvailable,true);assert.match(task.prompt,/Resolve this skill's relative references/);
});
test('native risky proposal stays pending until owner approval and retirement removes it from later seeds', {timeout:120_000},async t=>{
 const {api,id,run,learned,owner}=await fixture(t,'risky');const first=await run();const result=await learned(first);assert.equal(result.state,'merged',JSON.stringify(result));
 const path=`/agents/${id}/learning/files/release-status.md`;
 const status=async()=>(await api('GET',`/agents/${id}/learning`)).body.notes.items.find(n=>n.file==='release-status.md')?.status;
 const held=await api('GET',path);assert.equal(await status(),'pending');
 assert.equal((await api('POST',`${path}/approve`,{}, {'if-match':held.headers.get('etag')})).status,403);
 assert.equal((await owner('POST',`${path}/approve`,{}, {'if-match':held.headers.get('etag')})).status,200);
 const active=await api('GET',path);assert.equal(await status(),'active');
 assert.equal((await api('POST',`${path}/retire`,{}, {'if-match':active.headers.get('etag')})).status,200);
 assert.equal(await status(),'retired');
 const second=await run();assert.equal((await api('GET',`/runs/${second}`)).body.result.final_answer,'ready');
});
test('native malformed reflection fails closed before grader or promotion', {timeout:120_000},async t=>{
 const {api,id,run,learned,home}=await fixture(t,'invalid');const first=await run();const result=await learned(first);assert.notEqual(result.state,'merged');
 assert.deepEqual((await api('GET',`/agents/${id}/learning`)).body.notes.items,[]);
 const calls=(await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(!calls.some(c=>c.cwd.endsWith('native-grader')));
});

test('native verification cannot undo a newer disconnect or learning edit', {timeout:30_000},async t=>{
 const {api,id,home}=await fixture(t,'note');await writeFile(join(home,'verify-wait'),'yes');
 const verifying=api('POST',`/agents/${id}/native/verify`,{});
 for(let i=0;i<100;i++){try{await readFile(join(home,'verify-started'));break;}catch{await new Promise(r=>setTimeout(r,25));}}
 assert.equal((await api('POST',`/agents/${id}/native/disconnect`,{})).status,200);
 await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}});
 await writeFile(join(home,'verify-release'),'yes');assert.equal((await verifying).status,412);
 assert.equal((await api('GET',`/agents/${id}/native`)).body.native.connected,false);
 assert.equal((await api('GET',`/agents/${id}`)).body.definition.learning,false);
});

test('native failed terminal turn retains reported partial usage without duplicate booking', {timeout:30_000},async t=>{
 const {api,id}=await fixture(t,'failed-usage');await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}});
 const start=await api('POST',`/agents/${id}/runs`,{input:{content:'Fail after reporting known usage.'}});assert.equal(start.status,202);
 await follow(api,start.body.run_id,['failed']);const view=(await api('GET',`/runs/${start.body.run_id}`)).body;
 assert.equal(view.native.usage.task.input_tokens,100);assert.equal(view.native.usage.task.output_tokens,20);assert.equal(view.native.usage.task.cost_usd,null);assert.equal(view.native.usage.reflection.length,0);
 const stats=(await api('GET',`/stats?agent=${id}`)).body;assert.equal(stats.analytics.totals.requests,null);assert.equal(stats.analytics.totals.output,20);assert.equal(stats.analytics.totals.cache_write,null);
});

test('native cancel releases source-directory serialization and prevents a second overlapping dispatch', {timeout:60_000},async t=>{
 const {api,id,home,project}=await fixture(t,'blocked');await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}});
 const start=async()=>{const result=await api('POST',`/agents/${id}/runs`,{input:{content:'Wait for release.'}});assert.equal(result.status,202);return result.body.run_id;};
 const one=await start();const two=await start();
 const calls=async()=>{try{return (await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(c=>c.cwd===project);}catch{return [];}};
 for(let i=0;i<100&&!(await calls()).length;i++)await new Promise(r=>setTimeout(r,25));
 assert.equal((await calls()).length,1);
 assert.equal((await api('POST',`/runs/${one}/cancel`,{})).status,202);await follow(api,one,['cancelled']);
 await writeFile(join(home,'release-task'),'yes');await follow(api,two,['completed']);assert.equal((await calls()).length,2);
});

test('native incomplete policy is explicitly unavailable for learning and a forced proposal ends refused rather than remaining Proposed', {timeout:60_000},async t=>{
 const {api,id,project,run,learned,home}=await fixture(t,'skill');await writeFile(join(project,'AGENTS.md'),'A native policy rule.\n'.repeat(4000));
 const verified=await api('POST',`/agents/${id}/native/verify`,{});assert.equal(verified.body.native.state,'ready');assert.equal(verified.body.native.capabilities.notes,false);
 const first=await run();const result=await learned(first);assert.equal(result.state,'dropped',JSON.stringify(result));assert.match(result.detail,/grading evidence limit/);
 const calls=(await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(!calls.some(c=>c.cwd.endsWith('native-grader')));
});


test('native Codex aggregate input remains unknown when its cache-read split is unavailable', {timeout:30_000},async t=>{
 const {api,id}=await fixture(t,'unknown-cache');await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}});
 const start=await api('POST',`/agents/${id}/runs`,{input:{content:'Report simple readiness.'}});await follow(api,start.body.run_id,['completed']);
 const run=(await api('GET',`/runs/${start.body.run_id}`)).body;assert.equal(run.native.usage.task.input_tokens,100);assert.equal(run.native.usage.task.cache_read_tokens,null);
 const stats=(await api('GET',`/stats?agent=${id}`)).body;assert.equal(stats.analytics.totals.input,null);assert.equal(stats.analytics.totals.output,20);
});
