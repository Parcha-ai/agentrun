import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { nativeFixture } from './native-fixtures/setup.mjs';
import { discoverNative } from '../dist/native/discovery.js';
import { openNativeSession } from '../dist/native/runtime.js';

for(const runtime of ['claude-code','codex']) test(`${runtime} preserves native launch context and resumes the exact task session for bounded reflection`,async(t)=>{
 const f=await nativeFixture(t);
 await f.put(join(f.home,'.codex','review.config.toml'),'model = "native-model"\n');
 await f.put(join(f.home,'.codex','config.toml'),'[mcp_servers.docs]\ncommand = "docs"\n');
 await f.put(join(f.project,'.claude','agents','reviewer.md'),'---\nname: reviewer\n---\nReview.');
 const targets=(await discoverNative({project:f.project,runtime,env:f.env})).targets;
 const target=targets.find(x=>x.selector.kind!=='project');const events=[];
 const session=await openNativeSession({target,env:f.env,context:'AgentRun-owned learning: exact seed',onEvent:event=>events.push(event)});
 t.after(()=>session.close());
 const task=await session.send('Answer this task.');const reflection=await session.send('Return a learning proposal.',{reflection:true,timeoutMs:1000});
 assert.equal(task.answer,'native answer');assert.equal(reflection.sessionId,task.sessionId);
 assert.equal(task.usage.input_tokens,runtime==='codex'?9:7);assert.equal(task.usage.cache_write_tokens,null);
 assert.ok(events.some(x=>x.type==='session'&&x.sessionId===task.sessionId));
 const calls=(await f.calls()).filter(x=>!x.args.includes('--version')&&!x.args.includes('list'));
 assert.equal(calls.length,2);assert.ok(calls.every(x=>x.cwd===f.project&&x.home===f.home&&x.codexHome===f.env.CODEX_HOME));
 assert.ok(calls.every(x=>!x.args.some(a=>/dangerously|bypass|ignore-user|strict-mcp|setting-sources|full-auto|--last/.test(a))));
 if(runtime==='claude-code') {
  assert.ok(Math.abs(reflection.usage.cost_usd-0.02)<1e-12,'native cumulative cost must be converted to the reflection cost');
  assert.ok(calls[0].args.includes('--agent')&&calls[0].args.includes('reviewer'));
  assert.ok(calls[0].args.includes('--append-system-prompt')&&calls[0].args.includes('AgentRun-owned learning: exact seed'));
  assert.ok(calls[1].args.includes('--resume')&&calls[1].args.includes(task.sessionId));
  assert.ok(calls[1].args.includes('--tools')&&calls[1].args.includes(''));
 } else {
  assert.ok(calls[0].args.includes('--profile')&&calls[0].args.includes('review'));
  assert.ok(calls[1].args.includes('resume')&&calls[1].args.includes(task.sessionId));
  assert.ok(calls[1].args.includes('read-only'));assert.ok(calls[1].args.includes('mcp_servers.docs.enabled=false'));
  assert.ok(calls[1].args.includes('mcp_servers.inline-only.enabled=false'),'fully resolved native servers must be disabled even when absent from discovery labels');
  assert.ok(calls[1].args.includes('mcp_servers.inline-only.url="http://127.0.0.1:1"'),'inherited native transport definitions need a valid inert disabled override');
  assert.equal(reflection.usage.input_tokens,10);assert.equal(reflection.usage.output_tokens,3);assert.equal(reflection.usage.cache_read_tokens,1);
  assert.equal(task.usage.cost_usd,null);
 }
});

test('native cancellation and timeouts terminate dispatch and prohibit blind retries',async(t)=>{
 const f=await nativeFixture(t);const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 const session=await openNativeSession({target,env:f.env});t.after(()=>session.close());
 await assert.rejects(session.send('hang',{timeoutMs:30}),error=>error.code==='timeout');
 const beforeRetry=(await f.calls()).filter(x=>!x.args.includes('--version')).length;
 await assert.rejects(session.send('retry'),/Inspect its recorded outcome/);
 assert.equal((await f.calls()).filter(x=>!x.args.includes('--version')).length,beforeRetry);
 const cancelled=new AbortController();cancelled.abort();
 await assert.rejects(openNativeSession({target,env:f.env,signal:cancelled.signal}),error=>error.name==='AbortError');
});

test('native permission requests are recorded and fail closed with a recovery action',async(t)=>{
 const f=await nativeFixture(t);const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];const events=[];
 const session=await openNativeSession({target,env:{...f.env,NATIVE_TEST_DENY:'yes'},onEvent:async e=>{await new Promise(resolve=>setTimeout(resolve,5));events.push(e);}});t.after(()=>session.close());
 await assert.rejects(session.send('request a tool'),error=>error.code==='approval_required'&&/native CLI/.test(error.message));
 assert.ok(events.some(e=>e.type==='approval'&&e.tool==='Bash'));
});

test('invalid native JSON fails visibly without dispatching an automatic retry',async(t)=>{
 const f=await nativeFixture(t);const target=(await discoverNative({project:f.project,runtime:'codex',env:f.env})).targets[0];
 const session=await openNativeSession({target,env:{...f.env,NATIVE_TEST_MALFORMED:'yes'}});t.after(()=>session.close());
 await assert.rejects(session.send('answer'),error=>error.code==='protocol');
 assert.equal((await f.calls()).filter(x=>!x.args.includes('--version')).length,1);
});

for(const runtime of ['claude-code','codex'])test(`${runtime} duplicate native completion events do not double-count text or usage`,async(t)=>{
 const f=await nativeFixture(t);const target=(await discoverNative({project:f.project,runtime,env:f.env})).targets[0];const events=[];
 const session=await openNativeSession({target,env:{...f.env,NATIVE_TEST_DUPLICATE:'yes'},onEvent:e=>events.push(e)});t.after(()=>session.close());
 const result=await session.send('answer');assert.equal(result.answer,'native answer');
 assert.equal(events.filter(e=>e.type==='session').length,1);assert.equal(events.filter(e=>e.type==='text').length,1);assert.equal(events.filter(e=>e.type==='usage').length,1);
 assert.equal(result.usage.input_tokens,runtime==='codex'?9:7);
});
