#!/usr/bin/env node
// Opt-in acceptance against explicitly imported remote fixture agents. The source CLI worker must already be
// running. No provider credential or broad server token is delivered to that worker by this script.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (process.env.AGENTRUN_REMOTE_E2E !== '1') throw new Error('This test makes real model calls and changes fixture learning. Set AGENTRUN_REMOTE_E2E=1 only for approved fixture agents.');
const { values } = parseArgs({options:{url:{type:'string'},'token-file':{type:'string'},agents:{type:'string'},out:{type:'string'}}});
assert.ok(values.url && values['token-file'] && values.agents && values.out, 'Required: --url ORIGIN --token-file FILE --agents JSON_FILE --out DIRECTORY');
const origin = new URL(values.url);
assert.ok(origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname), 'Use HTTPS, or loopback for development.');
assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash, 'Use a plain server origin.');
const token = (await readFile(values['token-file'],'utf8')).trim();
const agents = JSON.parse(await readFile(values.agents,'utf8'));
assert.ok(Array.isArray(agents) && agents.length > 0 && agents.length <= 2);
const output = resolve(values.out); await mkdir(output,{recursive:true,mode:0o700});
const api = async(method,path,body) => {
  const response = await fetch(new URL(`/v2${path}`,origin), {method,redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${result.error?.message ?? 'request failed'}`);
  return result;
};
const wait = async(read,accept,label) => {
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (accept(result)) return result;
    await new Promise(resolve => setTimeout(resolve,1000));
  }
  throw new Error(`${label} timed out. Inspect its source session before starting another run.`);
};
const receipts = [];
for (const selected of agents) {
  const { agent_id: id, runtime } = selected;
  assert.ok(typeof id === 'string' && /^[\w.-]+$/.test(id) && ['claude-code','codex'].includes(runtime));
  const before = (await api('GET',`/agents/${id}/native`)).native;
  assert.ok(before?.remote?.connector_id && before?.remote?.target_id,'This acceptance test requires a remote binding.');
  assert.equal(before.runtime,runtime);
  const verified = (await api('POST',`/agents/${id}/native/verify`,{})).native;
  assert.equal(verified.state,'ready',verified.issues.join(' '));
  assert.ok(verified.capabilities.notes && verified.capabilities.skills);
  let seenWorking = false;
  const run = async(content) => {
    const started = await api('POST',`/agents/${id}/runs`,{input:{content}});
    console.log(`${runtime}: run ${started.run_id}`);
    const result = await wait(async()=>{
      const current = await api('GET',`/runs/${started.run_id}`);
      if (current.status === 'working') {
        seenWorking = true;
        await writeFile(join(output,`${runtime}-live.json`),JSON.stringify({run_id:current.run_id,agent_id:id,status:current.status,native:current.native},null,2),{mode:0o600});
      }
      return current;
    },value=>['completed','failed','cancelled','stopped'].includes(value.status),'Remote run');
    assert.equal(result.status,'completed',`${started.run_id}: ${result.error?.message ?? result.summary ?? result.status}`);
    assert.equal(result.native.machine_id,verified.machine_id);
    assert.equal(result.native.project,verified.project);
    assert.equal(result.imported_from,null,'New remote executions must not be mislabeled historical imports.');
    return result;
  };
  await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:'notes'}});
  console.log(`${runtime}: learning On; teach a stable preference`);
  const teach = await run('My stable preference for release readiness reports is the exact compact form "Shipment signal: <status>." with the status in lowercase. Please remember this for future release readiness reports. The current status is ready. Respond in that form only. Do not use tools or read or write files.');
  const learning = await wait(()=>api('GET',`/runs/${teach.run_id}/learning`),value=>['merged','dropped','rejected','failed','skipped'].includes(value.state),'Checked learning promotion');
  assert.equal(learning.state,'merged',`Learning was ${learning.state}; inspect the checks and grade. Do not bypass them.`);
  const revision = (await api('GET',`/agents/${id}/learning`)).main;
  assert.ok(revision);
  const question = 'Release readiness is ready. Report the status using my preferred compact format. Do not use tools or read or write files.';
  console.log(`${runtime}: accepted learning; fresh session must use the preference`);
  const reuse = await run(question);
  assert.equal(reuse.result.final_answer?.trim(),'Shipment signal: ready.');
  assert.equal(reuse.native.learning_revision,revision);
  assert.ok(teach.native.session_id && reuse.native.session_id);
  assert.notEqual(teach.native.session_id,reuse.native.session_id);
  assert.ok(teach.native.usage.reflection.length > 0,'Learning must reflect in the task session.');
  await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}});
  const off = await run(question);
  assert.equal(off.native.learning_revision,null);
  assert.equal(off.learning,null);
  assert.equal(off.native.usage.reflection.length,0);
  assert.notEqual(off.native.session_id,reuse.native.session_id);
  assert.notEqual(off.result.final_answer?.trim(),'Shipment signal: ready.','The Off control reproduced the lesson independently; this run does not prove learning affected the answer.');
  assert.ok(seenWorking,'A remote run must be visible while working.');
  // Leave the successful fixture ready for the user to explore with learning enabled.
  await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:'notes'}});
  const receipt = {runtime,agent_id:id,connector_id:before.remote.connector_id,source_machine_id:verified.machine_id,
    run_ids:{teach:teach.run_id,reuse:reuse.run_id,off:off.run_id},
    session_ids:{teach:teach.native.session_id,reuse:reuse.native.session_id,off:off.native.session_id},
    learning_revision:revision,checks_and_grade_promoted:true,fresh_session_used_lesson:true,off_supplied_no_learning:true,live_working_observed:true,
    answers:{teach:teach.result.final_answer,reuse:reuse.result.final_answer,off:off.result.final_answer},
    models:{teach:teach.native.model,reuse:reuse.native.model,off:off.native.model},
    usage:{teach:teach.native.usage,reuse:reuse.native.usage,off:off.native.usage}};
  receipts.push(receipt);
  await writeFile(join(output,'receipt.json'),JSON.stringify(receipts,null,2)+'\n',{mode:0o600});
  console.log(`${runtime}: PASS — checked learning reached a fresh remote session; Off omitted it`);
}
console.log(`Sanitized receipts: ${join(output,'receipt.json')}`);
