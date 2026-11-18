import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeFixture} from './native-fixtures/setup.mjs';
import {discoverNative} from '../dist/native/discovery.js';
import {openNativeSession} from '../dist/native/runtime.js';
import {serve,follow,withEnv} from "./support.mjs";

const sessionId='22222222-2222-4222-8222-222222222222';
const answer='```json\n{"ready":true}\n```';
const progress='Checking the source tools.';
const completed={type:'turn.completed',usage:{input_tokens:9,output_tokens:4,cached_input_tokens:2}};
const message=(id,text)=>({type:'item.completed',item:{id,type:'agent_message',text}});
const codexEvents=(final=answer)=>[
 {type:'thread.started',thread_id:sessionId},message('progress-1',progress),
 {type:'item.started',item:{id:'tool-1',type:'command_execution',command:'fixture status'}},
 {type:'item.completed',item:{id:'tool-1',type:'command_execution',status:'completed',aggregated_output:'ready'}},
 message('progress-2','The tool finished.'),message('final',final),message('final',final),completed,
];
const claudeEvents=()=>[
 {type:'system',subtype:'init',session_id:sessionId,model:'native-claude'},
 {type:'assistant',message:{content:[{type:'text',text:progress},{type:'tool_use',id:'tool-1',name:'fixture',input:{}}]}},
 {type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'ready'}]}},
 {type:'assistant',message:{content:[{type:'text',text:answer}]}},
 {type:'result',subtype:'success',session_id:sessionId,result:answer,usage:{input_tokens:7,output_tokens:3},total_cost_usd:0.01},
];
const dispatched=async f=>(await f.calls()).filter(c=>c.args.includes('exec')||c.args.includes('--print'));
async function opened(t,events,{onEvent,hold=false}={}){
 const f=await nativeFixture(t);const target=(await discoverNative({project:f.project,runtime:'codex',env:f.env})).targets[0];
 const env={...f.env,NATIVE_TEST_EVENTS:JSON.stringify(events),...(hold?{NATIVE_TEST_HOLD:'yes'}:{})};
 const session=await openNativeSession({target,env,onEvent});t.after(()=>session.close());
 return {f,env,session};
}

for(const runtime of ['claude-code','codex'])test(`${runtime} keeps progress and tools live but returns only the final answer`,async t=>{
 const f=await nativeFixture(t);const target=(await discoverNative({project:f.project,runtime,env:f.env})).targets[0];const events=[];
 const session=await openNativeSession({target,env:{...f.env,NATIVE_TEST_EVENTS:JSON.stringify(runtime==='codex'?codexEvents():claudeEvents())},onEvent:e=>events.push(e)});t.after(()=>session.close());
 const result=await session.send('Check readiness.');assert.equal(result.answer,answer);
 assert.deepEqual(events.filter(e=>e.type==='text').map(e=>e.text),runtime==='codex'?[progress,'The tool finished.',answer]:[progress,answer]);
 assert.deepEqual(events.filter(e=>e.type==='tool').map(e=>e.status),['started','completed']);
 assert.equal(events.filter(e=>e.type==='usage').length,1);assert.equal(result.usage.input_tokens,runtime==='codex'?9:7);
 assert.equal((await dispatched(f)).length,1,'duplicate final events never dispatch another task');
});

test('a Codex reflection turn answers its final message without retaining an earlier completed draft',async t=>{
 const final='Keep the checked preference.';
 const {f,env,session}=await opened(t,codexEvents());await session.send('Complete the task.');
 env.NATIVE_TEST_EVENTS=JSON.stringify([{type:'thread.started',thread_id:sessionId},message('draft','Discard this draft.'),message('final',final),completed]);
 const reflection=await session.send('Answer once more.',{reflection:true});
 assert.equal(reflection.answer,final);
 const calls=await dispatched(f);assert.equal(calls.length,2);assert.ok(calls[1].args.includes('resume'));assert.ok(calls[1].args.includes(sessionId));
});

for(const terminal of ['turn.failed','error','missing'])test(`Codex ${terminal} never returns earlier progress as a completed answer`,async t=>{
 const events=[{type:'thread.started',thread_id:sessionId},message('progress',progress),message('final',answer),...(terminal==='missing'?[]:[{type:terminal,error:{message:'fixture failure'}}])];
 const {f,session}=await opened(t,events);
 await assert.rejects(session.send('Fail after progress.'),e=>e.code==='failed');
 await assert.rejects(session.send('Do not replay.'),e=>e.code==='unavailable');assert.equal((await dispatched(f)).length,1);
});

test('Codex a completed turn with no agent message has an empty answer',async t=>{
 const {session}=await opened(t,[{type:'thread.started',thread_id:sessionId},completed]);
 assert.equal((await session.send('No answer.')).answer,'');
});

test('Codex cancellation after a final candidate refuses completion and blind replay',async t=>{
 const abort=new AbortController();const seen=[];
 const {f,session}=await opened(t,[{type:'thread.started',thread_id:sessionId},message('progress',progress),message('final',answer)],{hold:true,onEvent:e=>{seen.push(e);if(e.type==='text'&&e.text===answer)abort.abort();}});
 await assert.rejects(session.send('Stop after progress.',{signal:abort.signal}),e=>e.name==='AbortError');
 assert.equal(seen.find(e=>e.type==='text').text,progress);
 await assert.rejects(session.send('Do not replay.'),e=>e.code==='unavailable');assert.equal((await dispatched(f)).length,1);
});

for(const runtime of ['claude-code','codex'])test(`${runtime} valid final JSON after progress completes its HTTP run without an output retry`,{timeout:30_000},async t=>{
 const f=await nativeFixture(t);
 withEnv(t,{...Object.fromEntries(['PATH','HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','NATIVE_TEST_LOG'].map(key=>[key,f.env[key]])),NATIVE_TEST_EVENTS:JSON.stringify(runtime==='codex'?codexEvents():claudeEvents())});
 const {api}=await serve(t);
 const connected=await api('POST','/native/connect',{project:f.project,runtime});assert.equal(connected.status,200,JSON.stringify(connected.body));const id=connected.body.agent.agent_id;
 const saved=await api('PUT',`/agents/${id}/definition`,{definition:{instructions:'',learning:false,output_schema:{type:'object',additionalProperties:false,required:['ready'],properties:{ready:{type:'boolean'}}}}});assert.equal(saved.status,200,JSON.stringify(saved.body));
 const started=await api('POST',`/agents/${id}/runs`,{input:{content:'Check readiness with the source tools.'}});assert.equal(started.status,202,JSON.stringify(started.body));
 const {rows}=await follow(api,started.body.run_id,['completed']);
 const run=(await api('GET',`/runs/${started.body.run_id}`)).body;
 assert.equal((await dispatched(f)).length,1,'a valid final answer must not cause a second paid task');
 assert.equal(run.result.final_answer,answer);assert.deepEqual(run.result.output,{ready:true});assert.equal(run.result.output_error,undefined);
 assert.equal(rows.filter(row=>row.origin==='server'&&row.text?.startsWith('Your final JSON did not match')).length,0);
});
