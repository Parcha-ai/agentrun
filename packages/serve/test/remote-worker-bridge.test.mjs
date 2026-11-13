import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {nativeFixture} from './native-fixtures/setup.mjs';

function bridge(t, env, idleTimeoutMs) {
 const url=new URL('../dist/native/remote-worker-bridge.js',import.meta.url);
 const args=idleTimeoutMs===undefined?[fileURLToPath(url)]:['--input-type=module','--eval',`const {runRemoteWorkerBridge}=await import(${JSON.stringify(url.href)});await runRemoteWorkerBridge({idleTimeoutMs:${idleTimeoutMs}});`];
 const child=spawn(process.execPath,args,{env,stdio:['pipe','pipe','pipe']});
 const waiting=new Map(),events=[];let next=0,diagnostics='';
 child.stderr.on('data',chunk=>diagnostics+=chunk);
 const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{const message=JSON.parse(line);if(message.event){events.push(message);return;}const entry=waiting.get(message.id);if(entry){waiting.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error(message.error)):entry.resolve(message.result);}});
 child.on('exit',code=>{for(const entry of waiting.values()){clearTimeout(entry.timer);entry.reject(new Error(`Bridge exited ${code}: ${diagnostics}`));}waiting.clear();});
 t.after(async()=>{child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>child.kill('SIGTERM'),3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});});
 return {events,call:(type,body={})=>new Promise((resolve,reject)=>{const id=body.id??`request-${++next}`;const timer=setTimeout(()=>{waiting.delete(id);reject(new Error(`Bridge ${type} timed out: ${diagnostics}`));},10_000);waiting.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({...body,id,type})+'\n');})};
}

for(const runtime of ['claude-code','codex'])test(`remote ${runtime} reuses the native session and keeps learning additive`,async t=>{
 const f=await nativeFixture(t);await f.put(join(f.project,runtime==='codex'?'AGENTS.md':'CLAUDE.md'),'Source project policy remains unchanged.');
 const inputLog=join(f.root,'inputs.jsonl'),remote=bridge(t,{...f.env,NATIVE_TEST_INPUT_LOG:inputLog});
 const discovered=await remote.call('discover',{payload:{project:f.project,runtime}}),target=discovered.targets.find(t=>t.selector.kind==='project');
 const prepared=await remote.call('prepare',{target});
 assert.equal(prepared.target.connected,true);assert.match(prepared.instructions.text,/Source project policy/);
 await remote.call('open',{target,session_key:'task-session',payload:{context:'Use the approved learned preference.',skills:[{name:'approved-skill',files:{'SKILL.md':'Use the retained skill.','references/detail.md':'Read-only skill evidence.'}}]}});
 const first=await remote.call('send',{target,session_key:'task-session',payload:{prompt:'Perform this task.',timeout_ms:3000}});
 const second=await remote.call('send',{target,session_key:'task-session',payload:{prompt:'Reflect on the task.',reflection:true,timeout_ms:3000}});
 assert.equal(first.sessionId,second.sessionId);assert.equal(first.answer,'native answer');
 assert.ok(remote.events.some(e=>e.session_key==='task-session'&&e.event.type==='usage'));
 await assert.rejects(remote.call('close',{target:{...target,project:'/another/source'},session_key:'task-session'}),/different source target/);
 await remote.call('close',{target,session_key:'task-session'});
 const grade=await remote.call('grade',{target,payload:{prompt:'Evaluate this learning evidence.',timeout_ms:3000}});
 assert.equal(grade.answer,'native answer');
 const calls=(await f.calls()).filter(c=>c.args.includes('--print')||c.args.includes('exec'));
 assert.equal(calls.length,3);assert.equal(calls[0].cwd,f.project);assert.equal(calls[1].cwd,f.project);assert.notEqual(calls[2].cwd,f.project);
 assert.equal(await readFile(join(f.project,runtime==='codex'?'AGENTS.md':'CLAUDE.md'),'utf8'),'Source project policy remains unchanged.');
 assert.ok(calls.every(call=>!call.args.some(arg=>/dangerously|full-auto|bypass/.test(arg))));
 const firstText=runtime==='claude-code'?JSON.stringify(calls[0]):JSON.parse((await readFile(inputLog,'utf8')).split('\n')[0]).prompt;
 assert.match(firstText,/approved learned preference/);assert.match(firstText,/approved-skill/);
});

test('remote cancellation kills the native turn and refuses another turn in the failed session',async t=>{
 const f=await nativeFixture(t),remote=bridge(t,f.env);
 const target=(await remote.call('discover',{payload:{project:f.project,runtime:'claude-code'}})).targets[0];
 await remote.call('prepare',{target});await remote.call('open',{target,session_key:'cancelled-session'});
 const sent=remote.call('send',{id:'hanging-turn',target,session_key:'cancelled-session',payload:{prompt:'hang',timeout_ms:5000}});
 const refused=assert.rejects(sent,/cancel|abort/i);
 await new Promise(resolve=>setTimeout(resolve,150));
 await remote.call('cancel',{command_id:'hanging-turn'});await refused;
 await assert.rejects(remote.call('send',{target,session_key:'cancelled-session',payload:{prompt:'retry'}}),/closed|Inspect its recorded outcome/);
 assert.equal((await f.calls()).filter(c=>c.args.includes('--print')).length,1);
 await remote.call('close',{target,session_key:'cancelled-session'});
});

test('remote preparation pins source configuration and rejects changed instructions before dispatch',async t=>{
 const f=await nativeFixture(t),remote=bridge(t,f.env),path=join(f.project,'CLAUDE.md');
 await f.put(path,'Initial policy');const target=(await remote.call('discover',{payload:{project:f.project,runtime:'claude-code'}})).targets[0];
 await remote.call('prepare',{target});await f.put(path,'Changed policy');
 await assert.rejects(remote.call('open',{target,session_key:'changed'}),/configuration changed/);
 assert.equal((await f.calls()).filter(c=>c.args.includes('--print')).length,0);
});

test('a lost remote close cannot hold a source project lock indefinitely',async t=>{
 const f=await nativeFixture(t),remote=bridge(t,f.env,80);
 const target=(await remote.call('discover',{payload:{project:f.project,runtime:'claude-code'}})).targets[0];
 await remote.call('prepare',{target});await remote.call('open',{target,session_key:'abandoned'});
 await new Promise(resolve=>setTimeout(resolve,150));
 await assert.rejects(remote.call('send',{target,session_key:'abandoned',payload:{prompt:'No replay'}}),/session is unavailable/);
 await remote.call('open',{target,session_key:'replacement'});await remote.call('close',{target,session_key:'replacement'});
 assert.equal((await f.calls()).filter(c=>c.args.includes('--print')).length,0);
});
