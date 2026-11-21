import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,readdir,unlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {runCliLearningHook,flushCliLearning} from '../dist/cli-learning/hook.js';
import {saveConnection,stateHash,journalRoot} from '../dist/cli-learning/state.js';

async function fixture(t,runtime='codex'){
 const project=await mkdtemp(join(tmpdir(),'agentrun-hook-recovery-'));
 t.after(()=>rm(project,{recursive:true,force:true}));
 const options={runtime,project,dataDir:join(project,'private-data')};
 const transcript=join(project,'native.jsonl');
 await writeFile(transcript,JSON.stringify({type:'session_meta',payload:{id:'session-1',base_instructions:{text:'Keep source permissions.'}}})+'\n');
 const connection={version:1,...options,url:'http://127.0.0.1:7340',connection_id:'connection-1',agent_id:'agent-1',token:'fixture-connection-token'};
 await saveConnection(options.dataDir,connection);
 const root=journalRoot(options.dataDir,connection);
 const directory=join(root,stateHash('session-1')),pending=join(root,'pending');
 const calls=[];
 const dependencies={env:{},snapshot:async()=>({text:'Keep source permissions.',files:[],truncated:false}),fetch:async(url,request)=>{
  const path=new URL(url).pathname,body=JSON.parse(request.body);calls.push({path,body});
  return Response.json(path.endsWith('/runs')?{run_id:'run-1',agent_id:'agent-1',token:'fixture-run-token',learning:{enabled:true,revision:null,context:'',workflows:[]}}:{accepted:true});
 }};
 const input=(event,extra={})=>({hook_event_name:event,session_id:'session-1',[runtime==='codex'?'turn_id':'prompt_id']:'turn-1',cwd:project,transcript_path:transcript,...extra});
 const prompt=()=>runCliLearningHook(options,input('UserPromptSubmit',{prompt:'Report release status.'}),dependencies);
 const lock=async()=>{await mkdir(directory,{recursive:true});await writeFile(join(directory,'.lock'),JSON.stringify({pid:process.pid}));};
 const unlock=()=>unlink(join(directory,'.lock'));
 const finish=()=>appendFile(transcript,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Ready.'}]}})+'\n');
 const pendingCount=async()=>(await readdir(pending).catch(()=>[])).length;
 return {options,dependencies,root,directory,calls,input,prompt,lock,unlock,finish,pendingCount,transcript};
}

test('Stop survives a queued submit when the session lock clears before the terminal hook',async t=>{
 const f=await fixture(t);await f.lock();await f.prompt();await f.unlock();
 await f.finish();
 await runCliLearningHook(f.options,f.input('Stop',{last_assistant_message:'Ready.'}),f.dependencies);
 assert.equal(await f.pendingCount(),2,'both unmatched terminal and earlier submit stay durable');
 await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 const completions=f.calls.filter(call=>call.path.endsWith('/complete'));
 assert.equal(completions.length,1);
 assert.equal(completions[0].body.status,'completed');
 assert.equal(completions[0].body.answer,'Ready.');
 assert.equal(await f.pendingCount(),0);
});

test('SessionEnd waits for its queued submit and closes that recovered window as cancelled',async t=>{
 const f=await fixture(t);await f.lock();await f.prompt();await f.unlock();
 await runCliLearningHook(f.options,f.input('SessionEnd',{turn_id:undefined}),f.dependencies);
 assert.equal(await f.pendingCount(),2);
 await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 const completions=f.calls.filter(call=>call.path.endsWith('/complete'));
 assert.equal(completions.length,1);
 assert.equal(completions[0].body.status,'cancelled');
 assert.equal(completions[0].body.evidence_complete,false);
 assert.equal(await f.pendingCount(),0);
});

test('a submit replay repairs an orphan durable turn before SessionEnd or retry drains it',async t=>{
 const f=await fixture(t);await f.prompt();
 // Simulate the crash after turn.json was durable but before session.json was committed.
 await unlink(join(f.directory,'session.json'));
 await f.prompt();
 const session=JSON.parse(await readFile(join(f.directory,'session.json'),'utf8'));
 assert.equal(session.active.length,1,'existing turn is repaired into the active index');
 await runCliLearningHook(f.options,f.input('SessionEnd',{turn_id:undefined}),f.dependencies);
 await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 assert.equal(f.calls.filter(call=>call.path.endsWith('/runs')).length,1,'repair never starts the source window twice');
 assert.equal(f.calls.find(call=>call.path.endsWith('/complete')).body.status,'cancelled');
});

test('an unmatched terminal without a pending source prompt is acknowledged without endless retry',async t=>{
 const f=await fixture(t);
 await runCliLearningHook(f.options,f.input('Stop',{last_assistant_message:'Unenrolled earlier task.'}),f.dependencies);
 await runCliLearningHook(f.options,f.input('SessionEnd',{turn_id:undefined}),f.dependencies);
 assert.equal(await f.pendingCount(),0);
 assert.equal(f.calls.length,0);
});

test('Claude completion reports its source model when the native hook omits model',async t=>{
 const f=await fixture(t,'claude-code');await f.prompt();
 await appendFile(f.transcript,JSON.stringify({type:'assistant',sessionId:'session-1',message:{role:'assistant',model:'claude-sonnet-4-6',content:'Ready.'}})+'\n');
 await runCliLearningHook(f.options,f.input('Stop',{last_assistant_message:'Ready.'}),f.dependencies);
 assert.equal(f.calls.find(call=>call.path.endsWith('/complete')).body.model,'claude-sonnet-4-6');
});

test('late Claude policy capture reuses the standing files pinned before source execution',async t=>{
 const f=await fixture(t,'claude-code');
 const original={text:'Original standing policy.',files:[],truncated:false};
 let calls=0;
 f.dependencies.snapshot=async options=>{
  if(++calls===1)return {...original,sourceStanding:original};
  assert.deepEqual(options.pinnedStanding,original,'later capture cannot rediscover files edited by the source task');
  return {...original,text:original.text+' Actual native system snapshot.',sourceStanding:original};
 };
 await f.prompt();
 await appendFile(f.transcript,JSON.stringify({type:'assistant',sessionId:'session-1',message:{role:'assistant',content:'Ready.'}})+'\n');
 await runCliLearningHook(f.options,f.input('Stop',{last_assistant_message:'Ready.'}),f.dependencies);
 assert.equal(calls,2);
 assert.equal(f.calls.find(call=>call.path.endsWith('/complete')).body.source_policy.complete,true);
});

test('first Claude prompt binds a transcript created after submission before using dialogue or final policy',async t=>{
 const f=await fixture(t,'claude-code');await unlink(f.transcript);
 const {readTranscriptPolicy}=await import('../dist/cli-learning/policy.js');
 f.dependencies.snapshot=async options=>({...await readTranscriptPolicy(options),files:[],truncated:false});
 await f.prompt();
 assert.equal(f.calls.find(call=>call.path.endsWith('/runs')).body.policy_complete,false);
 await delay(5);
 const records=[
  {type:'queue-operation',operation:'enqueue'},
  {type:'user',sessionId:'session-1',promptId:'turn-1',uuid:'user-1',parentUuid:null,message:{role:'user',content:'Report release status.'}},
  {type:'attachment',sessionId:'session-1',uuid:'snapshot-1',parentUuid:'user-1',attachment:{type:'prompt_snapshot',systemPrompt:['Actual first-prompt policy.']}},
  {type:'assistant',sessionId:'session-1',uuid:'answer-1',parentUuid:'snapshot-1',message:{role:'assistant',model:'claude-sonnet-4-6',content:'Ready.'}},
 ];
 await writeFile(f.transcript,records.map(row=>JSON.stringify(row)).join('\n')+'\n');
 await runCliLearningHook(f.options,f.input('Stop',{last_assistant_message:'Ready.'}),f.dependencies);
 const completion=f.calls.find(call=>call.path.endsWith('/complete')).body;
 assert.equal(completion.evidence_complete,true);
 assert.equal(completion.source_policy.complete,true);
 assert.match(completion.source_policy.instructions,/Actual first-prompt policy/);
 assert.equal(completion.model,'claude-sonnet-4-6');
});

test('retry reports a pending source hook while another live process owns the session lock', async t => {
 const f=await fixture(t); await f.lock(); await f.prompt();
 const result=await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 assert.equal(result.pending,1);
 assert.equal(await f.pendingCount(),1);
 await f.unlock();
});

test('retry reports a frozen undelivered completion even when its session lock is busy', async t => {
 const f=await fixture(t); await f.prompt(); await f.finish();
 const request=f.dependencies.fetch;
 f.dependencies.fetch=async(url,options)=>{if(new URL(url).pathname.endsWith('/complete'))throw new Error('offline');return request(url,options);};
 await runCliLearningHook(f.options,f.input('Stop',{last_assistant_message:'Ready.'}),f.dependencies);
 await f.lock();
 const result=await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 assert.equal(result.pending,1);
 await f.unlock();
});

async function terminalReceipt(f, directory, key) {
 await mkdir(directory,{recursive:true});
 await writeFile(join(directory,`${key}.json`),JSON.stringify({
  version:1,key,connectionId:'connection-1',events:[],
  receipt:{run_id:'retry-run',agent_id:'agent-1',token:'fixture-run-token'},
  completion:{status:'completed',answer:'Ready.',session_id:'retry-session',evidence_complete:false,seed_observed:false},
 }));
}

test('bounded retries eventually reach a completion after more than 100 retained completed sessions',async t=>{
 const f=await fixture(t);
 for(let index=0;index<100;index++){
  const directory=join(f.root,index.toString(16).padStart(64,'0'));
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'session.json'),JSON.stringify({active:[],history:[],completed:['earlier-turn']}));
 }
 const directory=join(f.root,'f'.repeat(64)),key=stateHash('later-terminal');
 await terminalReceipt(f,directory,key);
 await writeFile(join(directory,'session.json'),JSON.stringify({active:[key],history:[],completed:[]}));
 let result;
 for(let attempt=0;attempt<3;attempt++)result=await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 assert.equal(f.calls.filter(call=>call.path.endsWith('/complete')).length,1,'retained completed sessions must not permanently hide later terminal receipts');
 assert.equal(result.pending,0);
});

test('bounded retries rotate past busy queued hooks instead of starving later sessions',async t=>{
 const f=await fixture(t),pending=join(f.root,'pending');
 await mkdir(pending,{recursive:true});
 const hooks=Array.from({length:101},(_,index)=>{
  const input=f.input('Stop',{session_id:`queued-session-${index}`,last_assistant_message:'Finished before enrollment.'});
  return {input,name:`${stateHash(JSON.stringify([input.session_id,input.turn_id,'Stop']))}.json`};
 }).sort((a,b)=>a.name.localeCompare(b.name));
 for(const [index,hook] of hooks.entries()){
  await writeFile(join(pending,hook.name),JSON.stringify({version:1,createdAt:index,input:hook.input}));
  if(index<100){
   const directory=join(f.root,stateHash(hook.input.session_id));
   await mkdir(directory,{recursive:true});
   await writeFile(join(directory,'.lock'),JSON.stringify({pid:process.pid}));
  }
 }
 await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 assert.equal(await f.pendingCount(),101,'the first retry has a bounded 100-hook budget');
 await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 await assert.rejects(readFile(join(pending,hooks.at(-1).name)),{code:'ENOENT'},'a later unlocked hook gets its next retry even while earlier locks stay busy');
 assert.equal(await f.pendingCount(),100);
 assert.equal(f.calls.length,0,'unmatched terminals never dispatch a source task');
});

test('bounded retries rotate past unfinished turns within one session',async t=>{
 const f=await fixture(t),keys=Array.from({length:100},(_,index)=>index.toString(16).padStart(64,'0'));
 const last='f'.repeat(64);
 await terminalReceipt(f,f.directory,last);
 await writeFile(join(f.directory,'session.json'),JSON.stringify({active:[...keys,last],history:[],completed:[]}));
 await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 assert.equal(f.calls.length,0,'one retry inspects at most 100 turns per session');
 const result=await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 assert.equal(f.calls.filter(call=>call.path.endsWith('/complete')).length,1);
 assert.equal(result.pending,0);
});

test('more than 100 queued session endings without earlier submits do not defer each other forever',async t=>{
 const f=await fixture(t),pending=join(f.root,'pending');
 await mkdir(pending,{recursive:true});
 for(let index=0;index<101;index++){
  const input=f.input('SessionEnd',{session_id:`ended-session-${index}`,turn_id:undefined});
  const name=`${stateHash(JSON.stringify([input.session_id,input.turn_id,'SessionEnd']))}.json`;
  await writeFile(join(pending,name),JSON.stringify({version:1,createdAt:index,input}));
 }
 await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 assert.equal(await f.pendingCount(),1,'a terminal-only queue makes progress within its 100-hook budget');
 const result=await flushCliLearning(f.options,{fetch:f.dependencies.fetch});
 assert.equal(result.pending,0);
 assert.equal(f.calls.length,0);
});
