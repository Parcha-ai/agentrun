import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appendFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay,setImmediate as tick} from 'node:timers/promises';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {nativeFixture} from './native-fixtures/setup.mjs';
import {discoverNative} from '../dist/native/discovery.js';
import {openNativeSession,NATIVE_EVENT_DRAIN_MS} from '../dist/native/runtime.js';
import {openSqliteStore} from '../dist/store/index.js';
import {createDispatchLoop} from '../dist/runner/dispatch.js';
import {createNativeLoop} from '../dist/runner/native-loop.js';
import {startRunner} from '../dist/runner/runner.js';
import {journalRecords} from '../dist/runner/journal-reader.js';
import {KINDS} from '../dist/runner/journal-kinds.js';
import {serve,follow,withEnv} from "./support.mjs";

const id='22222222-2222-4222-8222-222222222222';
const transcript=runtime=>runtime==='codex'?[
 {type:'thread.started',thread_id:id},
 {type:'item.started',item:{id:'tool',type:'command_execution',command:'fixture status'}},
 {type:'item.completed',item:{id:'tool',type:'command_execution',status:'completed',aggregated_output:'ready'}},
 {type:'item.completed',item:{id:'answer',type:'agent_message',text:'ready'}},
 {type:'turn.completed',usage:{input_tokens:9,output_tokens:4,cached_input_tokens:2,cache_write_input_tokens:0}},
]:[
 {type:'system',subtype:'init',session_id:id,model:'native-claude'},
 {type:'assistant',message:{content:[{type:'tool_use',id:'tool',name:'fixture',input:{}}]}},
 {type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'ready'}]}},
 {type:'assistant',message:{content:[{type:'text',text:'ready'}]}},
 {type:'result',subtype:'success',session_id:id,result:'ready',usage:{input_tokens:7,output_tokens:4},total_cost_usd:0.25},
];
// Fixture barriers must still fail on real time while a test advances the runtime's timeout clock.
const realSetTimeout=setTimeout,realClearTimeout=clearTimeout;
const within=async(promise)=>{
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=realSetTimeout(()=>reject(new Error('fixture did not reach its event barrier')),10_000);})]);}finally{realClearTimeout(timer);}
};

for(const runtime of ['claude-code','codex'])for(const reason of ['cancel','timeout'])test(`${runtime} ${reason} waits for already reported async events before rejecting`,{timeout:30_000},async t=>{
 const f=await nativeFixture(t),started=Promise.withResolvers(),release=Promise.withResolvers(),recorded=Promise.withResolvers();
 const target=(await discoverNative({project:f.project,runtime,env:f.env})).targets[0];const abort=new AbortController();
 const path=join(f.root,'persisted-events.jsonl');const seen=[];
 const session=await openNativeSession({target,env:{...f.env,NATIVE_TEST_EVENTS:JSON.stringify(transcript(runtime)),NATIVE_TEST_HOLD:'yes'},onEvent:async event=>{
  // Stop only once terminal usage is actually received, holding its durable write so the caller must
  // still wait for the recorder.
  if(event.type==='usage'){started.resolve();await release.promise;}
  await appendFile(path,JSON.stringify(event)+'\n');seen.push(event);if(event.type==='usage')recorded.resolve();
 }});
 t.after(async()=>{release.resolve();await session.close();});
 if(reason==='timeout'){t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());}
 let settled=false;const result=session.send('Report the source work.',{signal:abort.signal,timeoutMs:reason==='timeout'?500:10_000}).catch(error=>error).finally(()=>{settled=true;});
 await within(started.promise);
 assert.deepEqual(seen.filter(e=>e.type==='tool').map(e=>e.status),['started','completed']);
 assert.equal(seen.some(e=>e.type==='usage'),false,'terminal usage is received but its write is still held');
 if(reason==='cancel')abort.abort();else t.mock.timers.tick(500);
 await tick();
 try{assert.equal(settled,false,'the caller must retain the claim while reported events are still being recorded');}
 finally{release.resolve();await within(recorded.promise);}
 const error=await result;assert.equal(error.code,reason==='cancel'?'aborted':'timeout');
 const durable=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(durable,JSON.parse(JSON.stringify(seen)));assert.deepEqual(durable.filter(e=>e.type==='tool').map(e=>e.status),['started','completed']);assert.equal(durable.at(-1).type,'usage');
 await assert.rejects(session.send('Never replay.'),e=>e.code==='unavailable');
});

for(const runtime of ['claude-code','codex'])for(const late of [false,true])test(`${runtime} HTTP cancellation ${late?'before the CLI wrote its tool completion and usage records only the tool start, its usage unknown':'records queued tool completion and usage before its durable end'}`,{timeout:30_000},async t=>{
 // Queued: the fixture writes the whole transcript at once, so the server has queued every event before it records the
 // tool start this test holds. Late: the CLI writes its tool start, then is descheduled until the cancel has landed.
 const f=await nativeFixture(t),gate=join(f.root,'tail-gate');withEnv(t,{...Object.fromEntries(['PATH','HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','NATIVE_TEST_LOG'].map(k=>[k,f.env[k]])),NATIVE_TEST_EVENTS:JSON.stringify(transcript(runtime)),NATIVE_TEST_HOLD:'yes',...(late?{NATIVE_TEST_TAIL_AFTER:'2',NATIVE_TEST_TAIL_GATE:gate}:{})});
 const {api,data,store:reader}=await serve(t,{runner:false});let runner,store,release=Promise.withResolvers(),started=Promise.withResolvers(),stopped=Promise.withResolvers();let held=false,stopping=false;
 t.after(async()=>{release.resolve();await runner?.close();await store?.close();});
 const connected=await api('POST','/native/connect',{project:f.project,runtime});assert.equal(connected.status,200);const agent=connected.body.agent.agent_id;
 assert.equal((await api('PUT',`/agents/${agent}/definition`,{definition:{instructions:'',learning:false}})).status,200);
 store=await openSqliteStore({dataDir:data,role:'runner'});
 const dispatch=createDispatchLoop({launchOf:run=>store.runs.launch(run),resolve:(_name,launch)=>deps=>{
  const loop=createNativeLoop(launch,{store,data,sealKey:Buffer.alloc(32)})({...deps,journal:claim=>{
   const journal=deps.journal(claim);return new Proxy(journal,{get(target,property){const value=Reflect.get(target,property,target);
    if(property==='commit')return async(...args)=>{
     if(!held&&args[0].flat().some(w=>w.type==='entry'&&w.value.kind===KINDS.callStart)){held=true;started.resolve();await release.promise;held=false;}
     return value.apply(target,args);
    };
    if(property==='scanEntries')return async(...args)=>{const page=await value.apply(target,args);if(stopping&&held)release.resolve();return page;};
    return typeof value==='function'?value.bind(target):value;
   }});
  }});
  return {...loop,stop:reason=>{stopping=true;const result=loop.stop(reason);stopped.resolve();return result;}};
 }});
 runner=startRunner({store,name:'native-event-drain',leaseMs:60_000,renewEveryMs:1000,stopMarginMs:5000,pollMs:20,commandPollMs:30,createLoop:dispatch});
 const start=await api('POST',`/agents/${agent}/runs`,{input:{content:'Stop after the tool has reported.'}});assert.equal(start.status,202);const run=start.body.run_id;
 await within(started.promise);assert.equal((await api('POST',`/runs/${run}/cancel`,{})).status,202);await within(stopped.promise);if(late)await appendFile(gate,'');
 // The old path takes its end snapshot immediately and releases this gate there. The drained path has no end read
 // until its pending event commits; release independently rather than making that fixed path depend on the bug.
 await delay(1000);release.resolve();await follow(api,run,['cancelled']);
 const row=await reader.runs.get(run);const {entries}=await journalRecords(reader.readJournal(run),BACKGROUND_CONTEXT);
 // Events the CLI never delivered before the cancel are not invented: the run ends with its usage unknown, never 0.
 assert.equal(row.outcome,'cancelled');assert.equal(row.metrics.output,late?null:4,'reported usage survives the stop');
 assert.equal(row.costUsd,runtime==='codex'||late?null:0.25);
 // A native run's paid tool calls are its harness's own, never booked here: what they cost is unknown (null), never $0.
 const read=(await api('GET',`/runs/${run}`)).body;assert.equal(read.cost.tools_usd,null,`a native run's tools_usd is unknown: ${JSON.stringify(read.cost)}`);
 const events=entries.filter(e=>[KINDS.callStart,KINDS.callEnd,'agentrun.native.usage',KINDS.end].includes(e.kind));
 assert.deepEqual(events.map(e=>e.kind),late?[KINDS.callStart,KINDS.end]:[KINDS.callStart,KINDS.callEnd,'agentrun.native.usage',KINDS.end]);
 if(!late){assert.equal(events[1].data.output,'ready');assert.equal(events[2].data.usage.output_tokens,4);}
 assert.equal((await f.calls()).filter(c=>c.args.includes('exec')||c.args.includes('--print')).length,1);
});

test('a stalled event drain is bounded and never starts later queued callbacks after expiry',{timeout:15_000},async t=>{
 const f=await nativeFixture(t),started=Promise.withResolvers(),release=Promise.withResolvers(),finished=Promise.withResolvers();
 const target=(await discoverNative({project:f.project,runtime:'codex',env:f.env})).targets[0];const abort=new AbortController(),seen=[];
 const session=await openNativeSession({target,env:{...f.env,NATIVE_TEST_EVENTS:JSON.stringify(transcript('codex')),NATIVE_TEST_HOLD:'yes'},onEvent:async event=>{
  seen.push(event);if(event.type==='tool'&&event.status==='started'){started.resolve();await release.promise;finished.resolve();}
 }});t.after(async()=>{release.resolve();await session.close();});
 const result=session.send('Stop while the recorder is stalled.',{signal:abort.signal}).catch(e=>e);await within(started.promise);const at=Date.now();abort.abort();
 const error=await within(result);assert.equal(error.code,'aborted');assert.ok(Date.now()-at>=NATIVE_EVENT_DRAIN_MS-50);assert.ok(Date.now()-at<NATIVE_EVENT_DRAIN_MS+3000);
 const before=seen.slice();release.resolve();await within(finished.promise);await tick();
 assert.deepEqual(seen,before,'only the already in-flight callback can finish late');assert.equal(seen.some(e=>e.type==='usage'),false);
 await assert.rejects(session.send('Never replay.'),e=>e.code==='unavailable');
});

for(const stopped of [false,true])test(`event recording rejection ${stopped?'preserves the first cancellation':'is observed as the original failure'} without an unhandled rejection`,async t=>{
 const f=await nativeFixture(t),started=Promise.withResolvers(),release=Promise.withResolvers(),abort=new AbortController();const failure=new Error('fixture persistence failed');
 const target=(await discoverNative({project:f.project,runtime:'codex',env:f.env})).targets[0];let later=0;
 const session=await openNativeSession({target,env:{...f.env,NATIVE_TEST_EVENTS:JSON.stringify(transcript('codex')),NATIVE_TEST_HOLD:'yes'},onEvent:async event=>{
  if(event.type==='tool'&&event.status==='started'){started.resolve();await release.promise;throw failure;}if(event.type==='usage')later++;
 }});t.after(async()=>{release.resolve();await session.close();});
 const result=session.send('Record then fail.',{signal:abort.signal}).catch(e=>e);await within(started.promise);if(stopped)abort.abort();release.resolve();
 const error=await within(result);if(stopped)assert.equal(error.code,'aborted');else assert.equal(error,failure);assert.equal(later,0);
 await assert.rejects(session.send('Never replay.'),e=>e.code==='unavailable');
});
