import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,client} from './support.mjs';
import {cliPolicyOf,sdkInbox} from '../dist/sdk/runs.js';
const sourcePolicy = async (store,id) => cliPolicyOf((await store.runs.launch(id)).body,(await sdkInbox(store,id)).completion);

// Only native version/sign-in metadata is faked. The HTTP auth, durable inbox and
// source-policy snapshots are real; no runner or model process is started.
async function fixture(t,runtime='codex') {
 const dir=await mkdtemp(join(tmpdir(),'agentrun-cli-completion-'));
 const bin=join(dir,'bin'),home=join(dir,'home'),project=join(dir,'project');
 await Promise.all([mkdir(bin),mkdir(home),mkdir(project)]);
 const script=`#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args.includes('--version')){console.log(${JSON.stringify(runtime==='codex'?'codex-cli 0.169.0':'2.1.322 (Claude Code)')});process.exit(0);}\nif(args[0]==='login'){process.stderr.write('Logged in using ChatGPT\\n');process.exit(0);}\nif(args[0]==='auth'&&args[1]==='status'){console.log('{"loggedIn":true}');process.exit(0);}\nthrow new Error('Unexpected native execution: this fixture permits metadata only');\n`;
 await writeFile(join(bin,runtime==='codex'?'codex':'claude'),script,{mode:0o755});
 const before={PATH:process.env.PATH,CODEX_HOME:process.env.CODEX_HOME,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR};
 process.env.PATH=`${bin}:${before.PATH}`;process.env.CODEX_HOME=home;process.env.CLAUDE_CONFIG_DIR=home;
 let server;
 t.after(async()=>{await server?.stop();for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(dir,{recursive:true,force:true});});
 server=await serve(t,{runner:false});
 const enrolled=await server.api('POST','/cli-learning/connections',{runtime,project});
 assert.equal(enrolled.status,201,JSON.stringify(enrolled.body));
 const connection=enrolled.body,hook=client(server.baseUrl,connection.token);
 let turn=0;
 return {...server,connection,start:async(body={})=>{
  const turnId=`turn-${++turn}`;
  const result=await hook('POST',`/cli-learning/connections/${connection.connection_id}/runs`,{
   session_id:'existing-session',turn_id:turnId,input:'Remember to label release status Launch state.',
   instructions:'Keep user data private.',policy_complete:true,...body,
  },{'Idempotency-Key':turnId});
  assert.equal(result.status,201,JSON.stringify(result.body));
  const receipt=result.body,run=client(server.baseUrl,receipt.token);
  return {id:receipt.run_id,receipt,complete:body=>run('POST',`/cli-learning/runs/${receipt.run_id}/complete`,body)};
 }};
}
const completed={status:'completed',answer:'Launch state: ready',evidence_complete:true};

test('redacted CLI completion is retained as incomplete evidence',async t=>{
 const server=await fixture(t),run=await server.start();
 const response=await run.complete({...completed,answer:`Launch state: ${server.token}`});
 assert.equal(response.status,200,JSON.stringify(response.body));
 const inbox=await sdkInbox(server.store,run.id);
 assert.ok(!inbox.completion.answer.includes(server.token),'owner credential must not be persisted');
 assert.equal(inbox.evidence_incomplete,true,'redacted final evidence is incomplete even if the client claimed complete');
});

test('CLI completion cannot replace its source session, and omitted session remains valid',async t=>{
 const server=await fixture(t),run=await server.start();
 const foreign=await run.complete({...completed,session_id:'different-session'});
 assert.equal(foreign.status,422,JSON.stringify(foreign.body));
 assert.equal((await sdkInbox(server.store,run.id)).completion,undefined,'rejected identity does not close the window');
 assert.equal((await run.complete(completed)).status,200);
 assert.equal((await sourcePolicy(server.store,run.id)).instructions,'Keep user data private.');
 const same=await server.start();
 assert.equal((await same.complete({...completed,session_id:'existing-session'})).status,200);
});

test('Claude provisional policy remains incomplete without a complete final snapshot',async t=>{
 const server=await fixture(t,'claude-code');
 for(const source_policy of [undefined,{instructions:'Final policy is partial.',complete:false}]){
  const run=await server.start();
  assert.equal((await run.complete({...completed,...(source_policy?{source_policy}:{})})).status,200);
  assert.equal((await sourcePolicy(server.store,run.id)).complete,false);
 }
});

test('Claude completion pins the complete final policy and accepts only exact retries',async t=>{
 const server=await fixture(t,'claude-code'),run=await server.start({policy_complete:false,instructions:''});
 const source_policy={instructions:'The actual final native policy. Keep user data private.',complete:true};
 const body={...completed,source_policy};
 assert.equal((await run.complete(body)).status,200);
 assert.equal((await sourcePolicy(server.store,run.id)).instructions,source_policy.instructions);
 assert.equal((await run.complete(body)).status,200,'transport retries preserve the pinned final policy');
 assert.equal((await run.complete({...body,source_policy:{...source_policy,instructions:'Different policy.'}})).status,409);
 assert.equal((await sourcePolicy(server.store,run.id)).instructions,source_policy.instructions,'a retry cannot rewrite recorded source policy');
});

test('Claude final policy rejects unknown fields and oversized UTF-8 without closing the window',async t=>{
 const server=await fixture(t,'claude-code'),run=await server.start();
 for(const source_policy of [
  {instructions:'Policy',complete:true,authority:'administrator'},
  {instructions:'Policy',complete:'true'},
  {instructions:'Policy'},
  {instructions:'é'.repeat(131073),complete:true},
 ]){
  const response=await run.complete({...completed,source_policy});
  assert.equal(response.status,422,JSON.stringify(response.body));
  assert.equal((await sdkInbox(server.store,run.id)).completion,undefined);
 }
 const source_policy={instructions:'A bounded complete policy.',complete:true};
 assert.equal((await run.complete({...completed,source_policy})).status,200);
 assert.equal((await sourcePolicy(server.store,run.id)).instructions,source_policy.instructions);
});

test('redacted Claude policy remains incomplete even when the final answer is intact',async t=>{
 const server=await fixture(t,'claude-code'),run=await server.start();
 const response=await run.complete({...completed,source_policy:{instructions:`Keep this private: ${server.token}`,complete:true}});
 assert.equal(response.status,200,JSON.stringify(response.body));
 const inbox=await sdkInbox(server.store,run.id);
 assert.equal(inbox.completion.source_policy.complete,false);
 assert.ok(!inbox.completion.source_policy.instructions.includes(server.token));
 assert.equal((await sourcePolicy(server.store,run.id)).complete,false);
});

test('Codex refuses completion policy overrides and retains the original source policy',async t=>{
 const server=await fixture(t),run=await server.start();
 assert.equal((await run.complete({...completed,source_policy:{instructions:'Replacement policy.',complete:true}})).status,422);
 assert.equal((await sdkInbox(server.store,run.id)).completion,undefined);
 assert.equal((await run.complete(completed)).status,200);
 assert.equal((await sourcePolicy(server.store,run.id)).instructions,'Keep user data private.');
});


test('a CLI completion cannot claim observed guidance when no correction context was supplied',async t=>{
 const server=await fixture(t);
 const empty=await server.start();
 assert.equal(empty.receipt.learning.enabled,true);
 assert.ok(empty.receipt.learning.revision,'an empty learning repository still has a commit');
 assert.equal(empty.receipt.learning.context,'');
 const falseProof=await empty.complete({...completed,seed_observed:true,seed_revision:empty.receipt.learning.revision});
 assert.equal(falseProof.status,422,'a revision with no supplied context is not guidance delivery');
 assert.equal((await sdkInbox(server.store,empty.id)).completion,undefined);
 assert.equal((await empty.complete({...completed,seed_observed:false})).status,200);
 const disabled=await server.api('PUT',`/agents/${server.connection.agent_id}/definition`,{definition:{instructions:'',learning:false}});
 assert.equal(disabled.status,200);
 const off=await server.start();assert.equal(off.receipt.learning.enabled,false);
 const offProof=await off.complete({...completed,seed_observed:true});
 assert.equal(offProof.status,422,'Learning Off cannot prove guidance with two absent revision values');
 assert.equal((await sdkInbox(server.store,off.id)).completion,undefined);
 assert.equal((await off.complete({...completed,seed_observed:false})).status,200);
});
