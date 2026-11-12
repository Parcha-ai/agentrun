#!/usr/bin/env node
// Opt-in live acceptance. Uses the server's existing native sign-in; creates disposable source projects and ordinary
// agent revisions. No API key is copied, source instruction files are never modified, and no historical import is used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

if (process.env.AGENTRUN_NATIVE_E2E !== '1') throw new Error('This test makes real model calls. Set AGENTRUN_NATIVE_E2E=1 to run with your native sign-in.');
const { values } = parseArgs({options:{url:{type:'string',default:'http://127.0.0.1:7340'},'token-file':{type:'string'},runtime:{type:'string',default:'all'},out:{type:'string'},'project-root':{type:'string'},'claude-agent':{type:'string'},'codex-profile':{type:'string'}}});
if (!values['token-file']) throw new Error('--token-file must name the running local server data/.token (never put a token in arguments).');
const origin=new URL(values.url);assert.ok(['127.0.0.1','localhost','[::1]'].includes(origin.hostname),'Use a source-machine loopback server.');
const token=(await readFile(values['token-file'],'utf8')).trim();
const output=resolve(values.out??await mkdtemp(join(tmpdir(),'agentrun-native-live-')));await mkdir(output,{recursive:true,mode:0o700});
const api=async(method,path,body)=>{
 const response=await fetch(new URL(`/v2${path}`,origin),{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json();if(!response.ok)throw new Error(`${method} ${path}: ${response.status} ${data.error?.message??'request failed'}`);return data;
};
const wait=async(read,accept,label,limit=360_000)=>{
 const deadline=Date.now()+limit;let last;
 while(Date.now()<deadline){last=await read();if(accept(last))return last;await new Promise(r=>setTimeout(r,1000));}
 throw new Error(`${label} timed out (state ${last?.state??last?.status??'unknown'}). Inspect the run in AgentRun.`);
};
const run=async(agent,content)=>{
 const {run_id}=await api('POST',`/agents/${agent}/runs`,{input:{content}});
 const result=await wait(()=>api('GET',`/runs/${run_id}`),r=>['completed','failed','stopped','cancelled'].includes(r.status),'native run');
 assert.equal(result.status,'completed',`Run ${run_id} ended ${result.status}: ${result.error?.message??result.summary??''}`);
 return result;
};
const receipts=[];
for(const runtime of values.runtime==='all'?['claude-code','codex']:[values.runtime]){
 assert.ok(['claude-code','codex'].includes(runtime));
 const project=await mkdtemp(join(resolve(values['project-root']??output),`agentrun-${runtime}-project-`));await promisify(execFile)('git',['init','--quiet',project]);
 const instruction=join(project,runtime==='codex'?'AGENTS.md':'CLAUDE.md');
 await writeFile(instruction,'# Fixture project\nAnswer simple text tasks directly. Do not read or write files or use tools for these text tasks.\n');
 const before=createHash('sha256').update(await readFile(instruction)).digest('hex');
 const named=runtime==='claude-code'?values['claude-agent']:values['codex-profile'];
 const selector=named?{kind:runtime==='claude-code'?'agent':'profile',name:named}:{kind:'project'};
 const discovery=await api('POST','/native/discover',{runtime,project});const source=discovery.targets.find(t=>t.selector.kind===selector.kind&&t.selector.name===selector.name);assert.ok(source);
 const connected=await api('POST','/native/connect',{runtime,project,selector});const id=connected.agent.agent_id;
 assert.equal((await api('POST',`/native/connect`,{runtime,project,selector})).agent.agent_id,id,'connect must be idempotent');
 const checked=(await api('POST',`/agents/${id}/native/verify`,{})).native;assert.equal(checked.state,'ready',checked.issues.join(' '));
 assert.ok(checked.capabilities.notes&&checked.capabilities.skills,'The source policy must fit the grading evidence limit to test automatic learning.');
 await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:'notes'}});
 console.log(`${runtime}: connected and learning On; teaching first run`);
 const first=await run(id,'My stable preference for release readiness reports is the exact compact form "Release gate: <status>." with the status in lowercase. Please remember this for future release readiness reports. The current status is ready. Respond in that form only. Do not use tools or write files.');
 const learning=await wait(()=>api('GET',`/runs/${first.run_id}/learning`),x=>['merged','dropped','rejected','failed','skipped'].includes(x.state),'checked learning promotion');
 assert.equal(learning.state,'merged',`Learning for ${first.run_id} was ${learning.state}; inspect its checks and grading in AgentRun.`);
 const seed=(await api('GET',`/agents/${id}/learning`)).main;assert.ok(seed);
 console.log(`${runtime}: proposal checked, graded and promoted; starting fresh run`);
 const question='Release readiness is ready. Report the status using my preferred compact format. Do not use tools or read or write files.';
 const second=await run(id,question);
 assert.equal(second.result.final_answer?.trim(),'Release gate: ready.');
 assert.equal(second.native.learning_revision,seed);assert.notEqual(first.native.session_id,second.native.session_id);assert.equal(second.imported_from,null);
 await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false}});
 const off=await run(id,question);assert.equal(off.native.learning_revision,null);assert.equal(off.learning,null);assert.equal(off.native.usage.reflection.length,0);assert.notEqual(off.native.session_id,second.native.session_id);
 assert.notEqual(off.result.final_answer?.trim(),'Release gate: ready.','Off control independently reproduced the exact rule: choose a more discriminating lesson and rerun.');
 assert.equal(createHash('sha256').update(await readFile(instruction)).digest('hex'),before,'original source instruction file changed');
 const after=(await api('POST','/native/discover',{runtime,project})).targets.find(t=>t.selector.kind===selector.kind&&t.selector.name===selector.name);
 // Claude owns .claude.json bookkeeping and updates it during ordinary CLI use; static settings and instructions must stay unchanged.
 const staticFiles=target=>target.configuration.filter(file=>!(runtime==='claude-code'&&basename(file.path)==='.claude.json'));
 assert.deepEqual(staticFiles(after),staticFiles(source),'static native configuration changed');
 const receipt={runtime,agent_id:id,run_ids:{teach:first.run_id,reuse:second.run_id,off:off.run_id},sessions:{teach:first.native.session_id,reuse:second.native.session_id,off:off.native.session_id},learning_revision:seed,checks_and_grade_promoted:true,fresh_run_used_lesson:true,off_supplied_no_learning:true,source_instructions_unchanged:true,static_native_configuration_unchanged:true,usage:{teach:first.native.usage,reuse:second.native.usage,off:off.native.usage},models:{teach:first.native.model,reuse:second.native.model,off:off.native.model}};
 receipts.push(receipt);await writeFile(join(output,'receipt.json'),JSON.stringify(receipts,null,2)+'\n',{mode:0o600});
 console.log(`${runtime}: PASS — fresh run used promoted revision; Off control omitted it`);
}
console.log(`Sanitized receipts: ${join(output,'receipt.json')}`);
