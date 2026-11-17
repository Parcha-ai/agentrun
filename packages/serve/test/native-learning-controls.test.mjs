import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,symlink,chmod,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,follow,asOwner} from './support.mjs';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {journalRecords} from '../dist/runner/journal-reader.js';

async function fixture(t,scenario){
 const root=await mkdtemp(join(tmpdir(),'native-controls-'));const bin=join(root,'bin'),home=join(root,'codex-home'),project=join(root,'project');
 await Promise.all([mkdir(bin),mkdir(home),mkdir(project)]);await writeFile(join(home,'scenario'),scenario);
 await writeFile(join(project,'AGENTS.md'),'Source policy: Do not send release data to outside destinations.\n');
 const cli=new URL('./fixtures/native-pipeline-cli.mjs',import.meta.url).pathname;await chmod(cli,0o755);await symlink(cli,join(bin,'codex'));
 const old={PATH:process.env.PATH,CODEX_HOME:process.env.CODEX_HOME};process.env.PATH=`${bin}:${old.PATH}`;process.env.CODEX_HOME=home;
 t.after(async()=>{process.env.PATH=old.PATH;if(old.CODEX_HOME===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old.CODEX_HOME;await rm(root,{recursive:true,force:true});});
 const server=await serve(t,{accounts:true,openSetup:true});const {api}=server;
 const connected=await api('POST','/native/connect',{project,runtime:'codex'});assert.equal(connected.status,200);const id=connected.body.agent.agent_id;
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:true}})).status,200);
 const run=async()=>{const response=await api('POST',`/agents/${id}/runs`,{input:{content:'Remember this stable preference for repeated release work.'}});assert.equal(response.status,202,JSON.stringify(response.body));await follow(api,response.body.run_id,['completed']);return response.body.run_id;};
 const learned=async runId=>{let value;for(let i=0;i<150;i++){value=(await api('GET',`/runs/${runId}/learning`)).body;if(['merged','dropped','skipped','rejected','failed'].includes(value.state))return value;await new Promise(r=>setTimeout(r,100));}return value;};
 return {...server,id,run,learned,home,project,owner:asOwner(server)};
}
test('a native learning job keeps its known agent path and unknown cost in the cost series', {timeout:60_000},async t=>{
 const {api,id,run,learned,store}=await fixture(t,'plain');
 // No owner words and no workflow for a native job: its learning settles with nothing kept.
 const runId=await run();assert.equal((await learned(runId)).state,'dropped');
 const response=await api('GET',`/agents/${id}/learning/cost`);assert.equal(response.status,200);
 assert.deepEqual(response.body.runs.map(run=>run.run_id),[runId],'the native job is counted');
 assert.equal(response.body.total_runs,1);assert.equal(response.body.unknown_path_runs,0);
 assert.equal(response.body.runs[0].path,'agent');assert.equal(response.body.runs[0].total_usd,null,'unreported native spend remains unknown');
 assert.equal(response.body.unknown_cost_runs,1);
 assert.equal((await store.runs.get(runId)).metrics.path,'agent','the path is recorded at the native end');
});

test('native verification cannot undo a newer disconnect or learning edit', {timeout:30_000},async t=>{
 const {api,id,home}=await fixture(t,'plain');await writeFile(join(home,'verify-wait'),'yes');
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
 const {api,id,home,project,store}=await fixture(t,'blocked');await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}});
 const start=async()=>{const result=await api('POST',`/agents/${id}/runs`,{input:{content:'Wait for release.'}});assert.equal(result.status,202);return result.body.run_id;};
 const one=await start();
 const calls=async()=>{try{return (await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(c=>c.cwd===project);}catch{return [];}};
 for(const end=Date.now()+10_000;!(await calls()).length;await new Promise(r=>setTimeout(r,25)))assert.ok(Date.now()<end,'the first run dispatches');
 const two=await start();
 for(const end=Date.now()+10_000;(await store.runs.get(two)).state!=='parked';await new Promise(r=>setTimeout(r,25)))assert.ok(Date.now()<end,'the second run waits for the source lock');
 assert.equal((await calls()).length,1);
 assert.equal((await api('POST',`/runs/${one}/cancel`,{})).status,202);await follow(api,one,['cancelled']);
 await writeFile(join(home,'release-task'),'yes');await follow(api,two,['completed']);assert.equal((await calls()).length,2);
});

test('cancelling a native run waiting for the source project ends it without dispatching or disturbing the active run', {timeout:60_000},async t=>{
 const {api,id,home,project,store}=await fixture(t,'blocked');await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}});
 const start=async()=>{const result=await api('POST',`/agents/${id}/runs`,{input:{content:'Wait for release.'}});assert.equal(result.status,202);return result.body.run_id;};
 const calls=async()=>{try{return (await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(c=>c.cwd===project);}catch{return [];}};
 const active=await start();
 for(const end=Date.now()+10_000;!(await calls()).length;await new Promise(r=>setTimeout(r,25)))assert.ok(Date.now()<end,'the first run dispatches');
 const waiting=await start();
 for(const end=Date.now()+10_000;(await store.runs.get(waiting)).state!=='parked';await new Promise(r=>setTimeout(r,25)))assert.ok(Date.now()<end,'the second run waits for the source lock');
 assert.equal((await api('POST',`/runs/${waiting}/cancel`,{})).status,202);
 await follow(api,waiting,['cancelled'],{deadlineMs:5_000});
 assert.equal((await store.runs.get(waiting)).outcome,'cancelled');
 assert.equal((await store.runs.get(active)).state,'running','cancelling a waiter leaves the source owner running');
 assert.equal((await calls()).length,1,'the waiting run never dispatched');
 await writeFile(join(home,'release-task'),'yes');await follow(api,active,['completed']);
 assert.equal((await calls()).length,1);
});

for(const scenario of ['output-retry','output-miss']){
 test(`native ${scenario} preserves typed input and the output contract's one retry in the same session`, {timeout:60_000},async t=>{
  const {api,id,home}=await fixture(t,scenario);
  const inputSchema={type:'object',additionalProperties:false,required:['company'],properties:{company:{type:'string'}}};
  const outputSchema={type:'object',additionalProperties:false,required:['ready'],properties:{ready:{type:'boolean'}}};
  assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false,input_schema:inputSchema,output_schema:outputSchema}})).status,200);
  assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'Keep the source policy.'}})).status,200);
  const definition=(await api('GET',`/agents/${id}`)).body.definition;
  assert.deepEqual(definition.input_schema,inputSchema);assert.deepEqual(definition.output_schema,outputSchema);assert.ok(definition.native);
  assert.equal((await api('POST',`/agents/${id}/runs`,{input:{company:7}})).status,422,'typed input is checked before dispatch');
  const start=await api('POST',`/agents/${id}/runs`,{input:{company:'Acme'}});assert.equal(start.status,202);
  const {rows}=await follow(api,start.body.run_id,['completed']);
  const calls=(await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length,2,'one retry, even when the second answer still misses');assert.equal(calls[0].session,calls[1].session);
  assert.ok(calls[0].prompt.includes(JSON.stringify(outputSchema,null,2)),'the model receives the full output schema');
  assert.ok(calls[0].prompt.includes(JSON.stringify({company:'Acme'},null,2)),'the native task receives typed input without content');
  assert.match(calls[1].prompt,/^Your final JSON did not match the output schema:/);
  assert.equal(rows.filter(row=>row.origin==='server'&&row.text?.startsWith('Your final JSON did not match')).length,1);
  const run=(await api('GET',`/runs/${start.body.run_id}`)).body;
  assert.equal(run.native.usage.task.input_tokens,200,'task usage includes the retry');assert.equal(run.native.usage.task.output_tokens,40);
  if(scenario==='output-retry'){assert.deepEqual(run.result.output,{ready:true});assert.equal(run.result.output_error,undefined);}
  else{assert.equal(run.result.output,null);assert.match(run.result.output_error,/no fenced json block/);}
 });
}

test('native mixed text and typed input reaches the source session and durable person message intact', {timeout:30_000},async t=>{
 const {api,id,home,store}=await fixture(t,'plain');
 const input={content:'Review this company.',company:'Acme',employees:42,notes:'Keep ``` inside this field.'};
 const inputSchema={type:'object',additionalProperties:false,required:Object.keys(input),properties:{content:{type:'string'},company:{type:'string'},employees:{type:'integer'},notes:{type:'string'}}};
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false,input_schema:inputSchema}})).status,200);
 const start=await api('POST',`/agents/${id}/runs`,{input});assert.equal(start.status,202);
 await follow(api,start.body.run_id,['completed']);
 const calls=(await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,1);
 const {entries}=await journalRecords(store.readJournal(start.body.run_id),BACKGROUND_CONTEXT);
 const text=entries.find(entry=>entry.kind==='agentrun.message'&&entry.data?.role==='person')?.data.text;
 for(const prompt of [calls[0].prompt,text]){
  assert.equal(typeof prompt,'string');assert.ok(prompt.startsWith(input.content));
  const block=prompt.match(/\n(`{4})json\n([\s\S]+)\n\1(?:\n|$)/);assert.ok(block,'typed fields retain a fence longer than their own backticks');
  assert.deepEqual(JSON.parse(block[2]),{company:input.company,employees:input.employees,notes:input.notes});
 }
});

test('native definitions reject tool-call budgets on save and on launch of an older saved revision', {timeout:30_000},async t=>{
 const {api,id,store}=await fixture(t,'plain');
 const refused=await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false,max_tool_calls:1}});
 assert.equal(refused.status,422,JSON.stringify(refused.body));assert.match(JSON.stringify(refused.body),/definition.max_tool_calls/);
 const good=(await store.agents.get(id)).currentRevision;const revision=await store.agents.revision(good);
 await store.agents.addRevision({agentId:id,id:'native-old-budget',kind:revision.kind,body:{...revision.body,maxToolCalls:1}});
 const launch=await api('POST',`/agents/${id}/runs`,{input:{content:'Do not run without my budget.'}});
 assert.equal(launch.status,409,JSON.stringify(launch.body));assert.match(JSON.stringify(launch.body),/max_tool_calls/);
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false,max_tool_calls:0}})).status,422,'the removed setting is refused even when zero');
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}})).status,200,'saving without the removed field clears a legacy limit');
 assert.equal((await store.agents.revision((await store.agents.get(id)).currentRevision)).body.maxToolCalls,undefined);
});

test('native runner refuses a previously queued budgeted revision before source dispatch', {timeout:30_000},async t=>{
 const {api,id,store,home}=await fixture(t,'plain');
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}})).status,200);
 const good=(await store.agents.get(id)).currentRevision;const revision=await store.agents.revision(good);
 await store.agents.addRevision({agentId:id,id:'native-queued-budget',kind:revision.kind,body:{...revision.body,maxToolCalls:1}});
 await store.agents.setCurrent(id,good);
 const runId='native-queued-budget-run';
 await store.runs.create({id:runId,agentId:id,revisionId:'native-queued-budget'},{body:{input:{content:'Never silently ignore this limit.'},title:'Old queued native budget',place:{mode:'runner'},native:revision.body.native}});
 await follow(api,runId,['completed','failed']);
 const ended=await store.runs.get(runId);assert.equal(ended.state,'failed','a legacy tool budget must not be silently ignored');
 assert.match(ended.summary,/max_tool_calls/);
 await assert.rejects(readFile(join(home,'fixture-calls.jsonl'),'utf8'),{code:'ENOENT'},'no native command was dispatched');
});

test('a native permission denial ends the run before an output-schema retry can dispatch another task', {timeout:60_000},async t=>{
 const {api,id,home}=await fixture(t,'output-denied');
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false,output_schema:{type:'object'}}})).status,200);
 const start=await api('POST',`/agents/${id}/runs`,{input:{content:'Answer with structured readiness.'}});assert.equal(start.status,202);
 const {rows}=await follow(api,start.body.run_id,['failed']);
 const calls=(await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.length,1,'the denied turn is never retried for its invalid output');
 assert.equal(rows.filter(row=>row.origin==='server'&&row.text?.startsWith('Your final JSON did not match')).length,0);
 assert.match(JSON.stringify((await api('GET',`/runs/${start.body.run_id}`)).body.error),/Native approval is required/);
});

test('native incomplete policy is explicitly unavailable for learning and a forced proposal ends refused rather than remaining Proposed', {timeout:60_000},async t=>{
 const {api,id,project,run,learned,home}=await fixture(t,'plain');await writeFile(join(project,'AGENTS.md'),'A native policy rule.\n'.repeat(4000));
 const verified=await api('POST',`/agents/${id}/native/verify`,{});assert.equal(verified.body.native.state,'ready');assert.equal(verified.body.native.capabilities.notes,false);
 const first=await run();const result=await learned(first);assert.equal(result.state,'dropped',JSON.stringify(result));assert.match(result.detail,/grading evidence limit/);
 const calls=(await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(calls.filter(c=>c.cwd!==project),[],'nothing but the task reaches a source process');
});

test('Codex custom-policy evidence disables promotion while ordinary native tasks retain their source configuration', {timeout:60_000},async t=>{
 const {api,id,project,run,learned,home}=await fixture(t,'plain');
 const configuration='model_instructions_file = "standing-policy.md"\n';
 await writeFile(join(home,'config.toml'),configuration);await writeFile(join(home,'standing-policy.md'),'Require owner review.\n');
 const verified=await api('POST',`/agents/${id}/native/verify`,{});
 assert.equal(verified.body.native.state,'ready');assert.equal(verified.body.native.capabilities.launch,true);
 assert.equal(verified.body.native.capabilities.notes,false);assert.equal(verified.body.native.capabilities.skills,false);
 assert.match(verified.body.native.issues.join(' '),/incomplete.*Codex|Codex.*policy/i);
 const first=await run();const result=await learned(first);
 assert.equal(result.state,'dropped',JSON.stringify(result));assert.match(result.detail,/incomplete.*Codex|Codex.*policy/i);
 assert.equal((await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}})).status,200);
 const second=await run();assert.equal((await api('GET',`/runs/${second}`)).body.result.final_answer,'ready');
 const calls=(await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(calls.some(c=>c.cwd===project));assert.deepEqual(calls.filter(c=>c.cwd!==project),[],'nothing but the tasks reaches a source process');
 assert.equal(await readFile(join(home,'config.toml'),'utf8'),configuration);assert.equal(await readFile(join(home,'standing-policy.md'),'utf8'),'Require owner review.\n');
});


test('native Codex aggregate input remains unknown when its cache-read split is unavailable', {timeout:30_000},async t=>{
 const {api,id}=await fixture(t,'unknown-cache');await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}});
 const start=await api('POST',`/agents/${id}/runs`,{input:{content:'Report simple readiness.'}});await follow(api,start.body.run_id,['completed']);
 const run=(await api('GET',`/runs/${start.body.run_id}`)).body;assert.equal(run.native.usage.task.input_tokens,100);assert.equal(run.native.usage.task.cache_read_tokens,null);
 const stats=(await api('GET',`/stats?agent=${id}`)).body;assert.equal(stats.analytics.totals.input,null);assert.equal(stats.analytics.totals.output,20);
});

for (const [scenario, cacheWrite, input] of [['cache-write-known',20,50],['cache-write-unknown',null,null]]) {
 test(`native Codex ${scenario} preserves raw counters and books only known uncached input`, {timeout:30_000},async t=>{
  const {api,id,store}=await fixture(t,scenario);
  await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}});
  const start=await api('POST',`/agents/${id}/runs`,{input:{content:'Report readiness and usage.'}});assert.equal(start.status,202);
  const runId=start.body.run_id;await follow(api,runId,['completed']);
  const view=(await api('GET',`/runs/${runId}`)).body;
  assert.equal(view.native.usage.task.input_tokens,100,'the native inclusive counter stays unchanged');
  assert.equal(view.native.usage.task.cache_read_tokens,30);assert.equal(view.native.usage.task.cache_write_tokens,cacheWrite);
  const {entries}=await journalRecords(store.readJournal(runId),BACKGROUND_CONTEXT);
  const turns=entries.filter(entry=>entry.kind==='runner.turn');assert.equal(turns.length,1);
  assert.deepEqual(turns[0].data.usage,{...(input===null?{}:{input}),output:20,cacheRead:30,...(cacheWrite===null?{}:{cacheWrite})});
  const saved=await store.runs.get(runId);assert.equal(saved.metrics.input,input);assert.equal(saved.metrics.cacheWrite,cacheWrite);
  const stats=(await api('GET',`/stats?agent=${id}`)).body.analytics.totals;
  assert.equal(stats.input,input);assert.equal(stats.cache_read,30);assert.equal(stats.cache_write,cacheWrite);assert.equal(stats.output,20);
 });
}

test('native task usage stays unknown when an output retry fails without reporting counters', {timeout:30_000},async t=>{
 const {api,id,home,store}=await fixture(t,'output-retry-no-usage');
 await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false,output_schema:{type:'object',required:['ready'],properties:{ready:{type:'boolean'}}}}});
 const start=await api('POST',`/agents/${id}/runs`,{input:{content:'Report readiness as JSON.'}});assert.equal(start.status,202);
 await follow(api,start.body.run_id,['failed']);
 const calls=(await readFile(join(home,'fixture-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);assert.equal(calls[0].session,calls[1].session);
 const view=(await api('GET',`/runs/${start.body.run_id}`)).body;
 assert.deepEqual(view.native.usage.task,{input_tokens:null,output_tokens:null,cache_read_tokens:null,cache_write_tokens:null,cost_usd:null});
 const saved=await store.runs.get(start.body.run_id);assert.equal(saved.metrics.output,null,'stored totals already know a dispatched turn is missing');
});
