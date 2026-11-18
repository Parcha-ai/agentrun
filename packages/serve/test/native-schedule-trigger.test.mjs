// A schedule trigger on a connected (native) agent: the recurring job a live Claude Code or Codex setup runs. Every
// other trigger's run is capped, but a connected agent's runs keep their own CLI's limits and refuse a dollar cap, so a
// trigger on one takes no cap, and needs none: its firing starts the run, which the source CLI completes.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {serve,follow,startInProcessRunner,FAUX} from './support.mjs';
import {nativeFixture} from './native-fixtures/setup.mjs';

for (const runtime of ['claude-code','codex']) {
 test(`${runtime}: a schedule trigger on a connected agent needs no cap, refuses one, and its firing runs the job`,{timeout:120_000},async t=>{
  const f=await nativeFixture(t),names=['PATH','HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','NATIVE_TEST_LOG'];
  const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  for(const name of names)process.env[name]=f.env[name];
  t.after(()=>{for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}});
  const {api,data}=await serve(t,{runner:false});
  const connected=await api('POST','/native/connect',{project:f.project,runtime});
  assert.equal(connected.status,200,JSON.stringify(connected.body));
  const id=connected.body.agent.agent_id;
  const target={kind:'start_run',agent_id:id,input:{content:'Run the nightly build.'}};
  const capped=await api('POST','/triggers',{name:'nightly-capped',source:{kind:'schedule',every_s:3600},target:{...target,max_cost_usd:1}});
  assert.equal(capped.status,422,JSON.stringify(capped.body));
  assert.deepEqual(capped.body.error.fields.map((f)=>[f.field,f.reason]),[['target.max_cost_usd','not_allowed']]);
  // An effort is refused when the trigger is made: the run start refuses one, so every firing would fail.
  const effort=await api('POST','/triggers',{name:'nightly-effort',source:{kind:'schedule',every_s:3600},target:{...target,effort:'high'}});
  assert.equal(effort.status,422,JSON.stringify(effort.body));
  assert.deepEqual(effort.body.error.fields.map((f)=>[f.field,f.reason]),[['target.effort','not_allowed']]);
  const made=await api('POST','/triggers',{name:'nightly',source:{kind:'schedule',every_s:3600},target});
  assert.equal(made.status,201,JSON.stringify(made.body));
  const close=await startInProcessRunner(data,{faux:FAUX});t.after(close);
  const fired=await api('POST',`/triggers/${made.body.id}/fire`,undefined,{'idempotency-key':'first'});
  assert.equal(fired.status,202,JSON.stringify(fired.body));
  let firing;
  for(let i=0;i<200&&!firing?.run_id;i++){
   firing=(await api('GET',`/triggers/${made.body.id}/firings`)).body.firings?.[0];
   if(firing?.status==='failed')break;
   if(!firing?.run_id)await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(firing?.run_id,`the firing started a run: ${JSON.stringify(firing)}`);
  const run=(await api('GET',`/runs/${firing.run_id}`)).body;
  assert.equal(run.cost.cap_usd??null,null,'no dollar cap on a connected agent\'s run');
  await follow(api,firing.run_id,['completed']);
 });
}
