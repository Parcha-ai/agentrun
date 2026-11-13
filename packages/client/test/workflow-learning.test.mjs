import assert from 'node:assert/strict';
import test from 'node:test';
import { withCodexAgentLearning } from '../dist/codex.js';

const tools = [{name:'mcp:release/status',description:'Read the release status.',input_schema:{type:'object'},permission:'allow',price_usd:0}];
test('workflow-enabled SDK registration sends explicit backend capabilities and releases the run binding', async () => {
  const requests=[]; let bound=0,closed=0,input;
  const workflows={catalog:tools,adapters:[],bind(session){bound++;return {context:'Use the approved workflow bridge.',close(){closed++;}};}};
  const fetch=async(url,options)=>{const path=new URL(url).pathname; const body=options.body?JSON.parse(options.body):null; requests.push({path,body});
    if(path.endsWith('/agents/backend'))return Response.json({definition:{sdk:{runtime:'codex-sdk'}}});
    if(path.endsWith('/sdk-runs'))return Response.json({run_id:'run',agent_id:'backend',token:'fixture-scoped',console_url:'https://server.example/#/runs/run',learning:{enabled:true,revision:'r1',context:'',skills:[],workflows:[]}});
    if(path.endsWith('/sdk-runs/run'))return Response.json({run_id:'run',state:'completed',learning:{state:'dropped'}});
    return Response.json({accepted:true});};
  const native={startThread(){return {id:null,async run(value){input=value;return {finalResponse:'done',items:[]};},async runStreamed(){throw Error('unused');}};}};
  const wrapped=withCodexAgentLearning(native,{agentId:'backend',instructions:'Read release data only.',baseUrl:'https://server.example/v2',apiKey:'fake-test-key',workflows,fetch,pollIntervalMs:1});
  await wrapped.startThread().run('Report status.');await wrapped.flushLearning();
  assert.deepEqual(requests.find(x=>x.path.endsWith('/sdk-runs')).body.workflow_tools,tools);
  assert.equal(bound,1);assert.equal(closed,1);assert.match(input,/approved workflow bridge/);
});

import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkflowMcpBridge } from '../dist/workflows.js';
import * as workflowEngine from '@parcha/agentrun-dsl';
import { BackendLearningSession } from '../dist/learning.js';
import { withClaudeAgentLearning } from '../dist/claude.js';

const string = {type:'string'};
const workflow = {
  v:2,name:'release',
  schemas:{Input:{type:'object',required:['service'],properties:{service:string}},
    Status:{type:'object',required:['service','version'],properties:{service:string,version:string}},
    Output:{type:'object',required:['brief'],properties:{brief:string}}},
  input:{schemaId:'Input'},output:{schemaId:'Output',path:'report'},
  root:{node:'chain',steps:[
    {node:'call',label:'status',via:'tool',tool:'mcp:release/status',args:{service:'{service}'},out:'Status',as:'status',deadline_s:5},
    {node:'call',label:'format',via:'tool',tool:'mcp:release/format',args:{status:'{status}'},out:'Output',as:'report',deadline_s:5}
  ]}
};
const accepted = doc => ({name:'release',description:'Read fresh release status and format a brief.',workflow:JSON.stringify(doc)});
const capability = context => context.match(/Supply capability "([a-f0-9]+)"/)[1];
function makeTools(calls) {
  return [{...tools[0],input_schema:workflow.schemas.Input,output_schema:workflow.schemas.Status,
    execute(input,ctx){calls.push({name:'status',input,ctx});return {service:input.service,version:'current-2'};}},
  {name:'mcp:release/format',description:'Format the observed release status.',permission:'allow',price_usd:0,
    input_schema:{type:'object',required:['status'],properties:{status:workflow.schemas.Status}},output_schema:workflow.schemas.Output,
    execute(input,ctx){calls.push({name:'format',input,ctx});return {brief:`${input.status.service} ${input.status.version}`};}}];
}
function newSession(bridge,doc=workflow,id='run-1') {
  const events=[],outcomes=[];
  const scoped={sdkRuns:{async events(_,body){events.push(...body.events);},async complete(_,body){outcomes.push(body);},
    async get(){return {run_id:id,state:'completed',learning:{state:'dropped'}};}}};
  const session=new BackendLearningSession(scoped,{runId:id,consoleUrl:'https://server.example',learningEnabled:true,revision:'r1',context:'',skills:[],workflows:[accepted(doc)]},
    {workflows:bridge,pollIntervalMs:1});
  return {session,events,outcomes,capability:capability(session.workflowContext)};
}
async function setup(t,patch={}) {
  const calls=[],events=[];
  const bridge=await createWorkflowMcpBridge({engine:workflowEngine,tools:makeTools(calls),policy:()=> 'allow',onEvent:e=>events.push(e),...patch});
  const client=new Client({name:'workflow-test',version:'1.0.0'});
  t.after(async()=>{await client.close();await bridge.close();});
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:bridge.headers}}));
  return {bridge,client,calls,events,run:(receipt,input={service:'fresh-api'},name='release')=>client.callTool({name:'learned_workflow',arguments:{capability:receipt.capability,name,input}})};
}

test('a workflow bridge requires an explicitly supplied host engine before opening a listener', async () => {
  let unexpected;
  try {
    await assert.rejects(createWorkflowMcpBridge({tools:makeTools([]),policy:()=> 'allow'}).then(bridge=>{unexpected=bridge;return bridge;}),
      /explicit host workflow engine/i);
  } finally { await unexpected?.close(); }
});

test('engine callbacks are captured once while the injected real engine still uses guarded effects', async t=>{
  const invoked=[];
  const engine={
    inspectWorkflow(value){invoked.push('inspect');return workflowEngine.inspectWorkflow(value);},
    runWorkflow(...args){invoked.push('run');return workflowEngine.runWorkflow(...args);},
    resolveSchemaForWorkflow(...args){invoked.push('schema');return workflowEngine.resolveSchemaForWorkflow(...args);},
  };
  let permission='deny';
  const {bridge,calls,run}=await setup(t,{engine,policy:()=>permission});
  for(const name of Object.keys(engine))engine[name]=()=>{throw Error('mutated engine must never be invoked');};
  assert.equal((await run(newSession(bridge))).isError,true);
  assert.equal(calls.length,0,'injected execution cannot bypass the live tool policy');
  permission='allow';
  const result=await run(newSession(bridge));
  assert.equal(result.isError,undefined);
  assert.equal(result.content[0].text,'fresh-api current-2');
  assert.deepEqual(calls.map(call=>call.name),['status','format']);
  assert.ok(['inspect','run','schema'].every(name=>invoked.includes(name)),JSON.stringify(invoked));
});

test('real MCP workflow reuses exact backend callbacks with fresh inputs, schemas and unchanged textual output',async t=>{
  const {bridge,client,calls,events,run}=await setup(t);
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['learned_workflow']);
  const receipt=newSession(bridge);
  assert.match(receipt.session.workflowContext,/input_schema.*service/);
  const result=await run(receipt);
  assert.equal(result.isError,undefined,JSON.stringify(result));
  assert.equal(result.content[0].text,'fresh-api current-2');
  assert.deepEqual(calls.map(c=>c.name),['status','format']);
  assert.deepEqual(calls[1].input,{status:{service:'fresh-api',version:'current-2'}});
  assert.ok(calls.every(c=>c.ctx.workflow==='release'&&c.ctx.runId==='run-1'));
  assert.equal(events.at(-1).status,'completed');
  assert.equal(receipt.events.filter(e=>e.type==='tool'&&e.status==='completed').length,3);
  assert.ok(!JSON.stringify(receipt.events).includes('fresh-api'),'private callback data is not uploaded');
  await receipt.session.complete({status:'completed',answer:'done'});
  assert.equal((await run(receipt)).isError,true,'completion revokes the capability');
  assert.equal(calls.length,2);
});

test('capabilities cannot name unpinned workflows, expire and stay isolated across concurrent native tasks',async t=>{
  const {bridge,calls,run}=await setup(t,{leaseDurationMs:200});
  const first=newSession(bridge,workflow,'first'),second=newSession(bridge,workflow,'second');
  assert.notEqual(first.capability,second.capability);
  assert.equal((await run({...first,capability:'wrong'})).isError,true);
  assert.equal((await run(first,{},'invented')).isError,true);
  const results=await Promise.all([run(first,{service:'one'}),run(second,{service:'two'})]);
  assert.ok(results.every(r=>!r.isError));
  assert.deepEqual(new Set(calls.map(c=>c.ctx.runId)),new Set(['first','second']));
  first.session.closeWorkflows();
  assert.equal((await run(first)).isError,true);
  await new Promise(resolve=>setTimeout(resolve,220));
  assert.equal((await run(second)).isError,true);
  assert.equal(calls.length,4);
});

test('backend policy remains live and schema failures or ask decisions invoke no tools',async t=>{
  let permission='deny';
  const {bridge,calls,run}=await setup(t,{policy:()=>permission});
  assert.equal((await run(newSession(bridge))).isError,true);
  permission='ask';
  assert.equal((await run(newSession(bridge))).isError,true);
  permission='allow';
  assert.equal((await run(newSession(bridge),{service:123})).isError,true);
  assert.equal(calls.length,0);
  assert.equal((await run(newSession(bridge),{service:'now-allowed'})).isError,undefined);
  assert.equal(calls.length,2);
});

test('admission rejects code, shell, executor, unknown tools, hidden model tools and retries before any effects',async t=>{
  const {bridge,calls,run}=await setup(t,{runNode:async()=>{throw Error('must not invoke');}});
  const replace=patch=>({...workflow,root:{node:'chain',steps:[workflow.root.steps[0],{...workflow.root.steps[1],...patch}]}});
  for(const doc of [
    replace({via:'shell',tool:undefined,cmd:'echo unsafe'}),
    replace({via:'executor',tool:undefined,executor:'python'}),
    replace({node:'code',code:'throw Error("unsafe")'}),
    replace({tool:'mcp:other/admin'}),
    replace({retry:{attempts:2}}),
    {...workflow,root:{node:'chain',steps:[workflow.root.steps[0],{node:'agent',label:'hidden',instructions:'Use a secret tool',out:'Output',as:'report',tools:['mcp:release/status']}]}}
  ]) { assert.equal((await run(newSession(bridge,doc))).isError,true); }
  assert.equal(calls.length,0);
});

test('static ask/deny tool declarations and model adapters are never inferred',async t=>{
  const calls=[];const registered=makeTools(calls);registered[1].permission='ask';
  const {bridge,run}=await setup(t,{tools:registered});
  assert.equal((await run(newSession(bridge))).isError,true);
  const model={...workflow,root:{node:'extract',label:'answer',out:'Output',as:'report',instructions:'Write a report.'}};
  assert.equal((await run(newSession(bridge,model))).isError,true);
  assert.equal(calls.length,0);
});

test('the injected engine preserves explicit host model and judge adapters and their cancellation signals',async t=>{
  const requests=[];
  const {bridge,client,run}=await setup(t,{
    runNode:async request=>{requests.push(['node',request]);assert.equal(request.signal.aborted,false);return {brief:'host-produced answer'};},
    runJudge:async request=>{requests.push(['judge',request]);assert.equal(request.signal.aborted,false);return {answers:{right:{type:'noul',noul:1}}};},
  });
  assert.deepEqual(bridge.adapters,['runNode','runJudge']);
  assert.equal((await client.listTools()).tools[0].annotations.readOnlyHint,false);
  const doc={...workflow,schemas:{...workflow.schemas,Check:{type:'object',properties:{right:{type:'boolean',description:'Is this answer correct?'}},required:['right']}},
    root:{node:'chain',steps:[{node:'extract',label:'answer',out:'Output',as:'report',instructions:'Produce the report.'},
      {node:'judge',label:'check',state:{answer:'{report}'},out:'Check',as:'checked'}]}};
  const result=await run(newSession(bridge,doc));
  assert.equal(result.isError,undefined,JSON.stringify(result));
  assert.equal(result.content[0].text,'host-produced answer');
  assert.deepEqual(requests.map(([kind])=>kind),['node','judge']);
  assert.equal(requests[0][1].kind,'extract');
  assert.equal(requests[1][1].questions.right.type,'noul');
});

test('native cancellation aborts an admitted callback, prevents further effects and marks evidence incomplete',async t=>{
  const calls=[];let admitted,stopped;const started=new Promise(r=>admitted=r),aborted=new Promise(r=>stopped=r);
  const registered=makeTools(calls);
  registered[0].execute=async(_,ctx)=>{admitted();await new Promise(resolve=>ctx.signal.addEventListener('abort',()=>{stopped();resolve();},{once:true}));return {service:'late',version:'late'};};
  const {bridge,run}=await setup(t,{tools:registered});
  const receipt=newSession(bridge),controller=new AbortController();receipt.session.followAbort(controller.signal);
  const pending=run(receipt);await started;controller.abort();await aborted;
  assert.equal((await pending).isError,true);
  assert.equal(calls.length,0);
  await assert.rejects(receipt.session.complete({status:'cancelled',answer:''}),/workflow/i);
  assert.equal(receipt.outcomes[0].evidence_complete,false);
  assert.equal((await run(receipt)).isError,true);
});

test('timeouts do not retry uncertain callbacks or advance to subsequent effects',async t=>{
  let calls=0;const registered=makeTools([]);registered[0].execute=()=>{calls++;return new Promise(()=>{});};
  const {bridge,run}=await setup(t,{tools:registered,maxDurationMs:30});
  const receipt=newSession(bridge);
  assert.equal((await run(receipt)).isError,true);
  assert.equal((await run(receipt)).isError,true);
  assert.equal(calls,1);
  await assert.rejects(receipt.session.complete({status:'completed',answer:'native error handled'}),/pending/i);
  assert.equal(receipt.outcomes[0].evidence_complete,false);
});

test('tool budgets span invocations and do not fabricate successful output',async t=>{
  const {bridge,calls,run}=await setup(t,{maxToolCalls:1});
  const receipt=newSession(bridge);
  assert.equal((await run(receipt)).isError,true);assert.equal(calls.length,1);
  assert.equal((await run(receipt)).isError,true);assert.equal(calls.length,1);
});

test('loopback MCP requires bearer auth and rejects cross-origin, DNS rebinding, wrong paths and oversized requests',async t=>{
  const {bridge}=await setup(t);
  const request=(patch={})=>fetch(bridge.url,{method:'POST',headers:{'content-type':'application/json',...bridge.headers,...patch},body:'{}'});
  assert.equal((await request({Authorization:'Bearer wrong'})).status,403);
  assert.equal((await request({Origin:'https://attacker.example'})).status,403);
  const rebound=await new Promise((resolve,reject)=>{const req=httpRequest(bridge.url,{method:'POST',headers:{...bridge.headers,host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');});
  assert.equal(rebound,403);
  assert.equal((await fetch(bridge.url+'/extra',{method:'POST',headers:bridge.headers,body:'{}'})).status,404);
  assert.equal((await fetch(bridge.url,{method:'POST',headers:bridge.headers,body:'x'.repeat(131073)})).status,413);
});

test('ephemeral capability and bridge bearer are removed from stored evidence without mutating native values',async t=>{
  const {bridge}=await setup(t);const receipt=newSession(bridge);
  const event={type:'text',text:`${receipt.capability} ${bridge.headers.Authorization}`};
  await receipt.session.event(event);
  const outcome={status:'completed',answer:event.text};await receipt.session.complete(outcome);
  assert.equal(event.text,outcome.answer,'original records remain unchanged');
  assert.ok(event.text.includes(receipt.capability));
  assert.ok(!JSON.stringify([receipt.events,receipt.outcomes]).includes(receipt.capability));
  assert.ok(!JSON.stringify([receipt.events,receipt.outcomes]).includes(bridge.headers.Authorization.slice(7)));
});

test('Codex revokes workflow capability on native return before blocked buffered evidence drains',async t=>{
  const {bridge,run}=await setup(t);let prompt,release;const blocked=new Promise(r=>release=r);let blockedOnce=false;
  const fetch=async(url,options)=>{const path=new URL(url).pathname;
    if(path.endsWith('/agents/backend'))return Response.json({definition:{sdk:{runtime:'codex-sdk'}}});
    if(path.endsWith('/sdk-runs'))return Response.json({run_id:'run',agent_id:'backend',token:'fixture-scoped',console_url:'https://server.example',learning:{enabled:true,revision:'r1',context:'',skills:[],workflows:[accepted(workflow)]}});
    if(path.endsWith('/events')&&!blockedOnce){blockedOnce=true;await blocked;}
    if(path.endsWith('/sdk-runs/run'))return Response.json({run_id:'run',state:'completed',learning:{state:'dropped'}});
    return Response.json({accepted:true});};
  const result={finalResponse:'original output',items:[{type:'agent_message',text:'original output'}]};
  const native={startThread(){return {id:null,async run(value){prompt=value;return result;},async runStreamed(){throw Error('unused');}};}};
  const wrapped=withCodexAgentLearning(native,{agentId:'backend',instructions:'Original policy',baseUrl:'https://server.example/v2',apiKey:'fixture',workflows:bridge,fetch,pollIntervalMs:1});
  assert.equal(await wrapped.startThread().run('Report status.'),result);
  assert.equal((await run({capability:capability(prompt)})).isError,true);
  release();await wrapped.flushLearning();
});

test('Claude preserves native options and event identity while binding then revoking workflow context',async t=>{
  const {bridge,run}=await setup(t);let prompt;const options={model:'test',mcpServers:{existing:{type:'http',url:'http://localhost:1'}}};
  const terminal={type:'result',subtype:'success',result:'done',usage:{input_tokens:1,output_tokens:1}};
  const fetch=async(url)=>{const path=new URL(url).pathname;
    if(path.endsWith('/agents/backend'))return Response.json({definition:{sdk:{runtime:'claude-agent-sdk'}}});
    if(path.endsWith('/sdk-runs'))return Response.json({run_id:'run',agent_id:'backend',token:'fixture-scoped',console_url:'https://server.example',learning:{enabled:true,revision:'r1',context:'',skills:[],workflows:[accepted(workflow)]}});
    if(path.endsWith('/sdk-runs/run'))return Response.json({run_id:'run',state:'completed',learning:{state:'dropped'}});
    return Response.json({accepted:true});};
  const native=params=>{prompt=params.prompt;assert.equal(params.options,options);return (async function*(){yield terminal;})();};
  const wrapped=withClaudeAgentLearning(native,{agentId:'backend',instructions:'Original policy',baseUrl:'https://server.example/v2',apiKey:'fixture',workflows:bridge,fetch,pollIntervalMs:1});
  const received=[];for await(const event of wrapped({prompt:'Report status.',options}))received.push(event);
  assert.equal(received[0],terminal);assert.match(prompt,/input_schema/);
  assert.equal((await run({capability:capability(prompt)})).isError,true);
  await wrapped.flushLearning();
});

test('a policy revoked by the first tool blocks the second tool in that same pinned workflow',async t=>{
  let permission='allow',calls=0;const registered=makeTools([]);
  const original=registered[0].execute;registered[0].execute=(input,ctx)=>{calls++;permission='deny';return original(input,ctx);};
  registered[1].execute=()=>{throw Error('must not dispatch');};
  const {bridge,run}=await setup(t,{tools:registered,policy:()=>permission});
  assert.equal((await run(newSession(bridge))).isError,true);
  assert.equal(calls,1);
});

test('output schema failure and node limits stop dependent effects and block replay',async t=>{
  let calls=0;const registered=makeTools([]);registered[0].execute=()=>{calls++;return {unexpected:'result'};};
  const {bridge,run}=await setup(t,{tools:registered});const receipt=newSession(bridge);
  assert.equal((await run(receipt)).isError,true);assert.equal(calls,1);
  assert.equal((await run(receipt)).isError,true);assert.equal(calls,1);
  const limited=await setup(t,{maxNodeSteps:1});
  assert.equal((await limited.run(newSession(limited.bridge))).isError,true);
  assert.equal(limited.calls.length,1);
});

test('a closed bridge completes the server receipt without dispatching any native task',async t=>{
  const {bridge}=await setup(t);await bridge.close();const requests=[];let nativeCalled=false;
  const fetch=async(url,options)=>{const path=new URL(url).pathname;const body=options.body?JSON.parse(options.body):undefined;requests.push({path,body});
    if(path.endsWith('/agents/backend'))return Response.json({definition:{sdk:{runtime:'codex-sdk'}}});
    if(path.endsWith('/sdk-runs'))return Response.json({run_id:'run',agent_id:'backend',token:'fixture-scoped',console_url:'https://server.example',learning:{enabled:true,revision:'r1',context:'',skills:[],workflows:[]}});
    return Response.json({accepted:true});};
  const native={startThread(){return {id:null,async run(){nativeCalled=true;},async runStreamed(){throw Error('unused');}};}};
  const wrapped=withCodexAgentLearning(native,{agentId:'backend',instructions:'Original policy',baseUrl:'https://server.example/v2',apiKey:'fixture',workflows:bridge,fetch});
  await assert.rejects(wrapped.startThread().run('Report status.'),/cannot bind/);
  assert.equal(nativeCalled,false);
  const completed=requests.find(request=>request.path.endsWith('/complete'));
  assert.equal(completed.body.status,'failed');assert.equal(completed.body.evidence_complete,false);
});

test('MCP read-only annotation requires explicit read-only callbacks and no model adapters',async t=>{
  const readonly=()=>makeTools([]).map(tool=>({...tool,readOnly:true}));
  const cases=[
    ['explicit read-only callbacks',{tools:readonly()},true],
    ['unspecified callbacks',{tools:makeTools([])},false],
    ['one mutable callback',{tools:readonly().map((tool,index)=>({...tool,readOnly:index===0}))},false],
    ['denied mutable callback',{tools:[...readonly(),{...makeTools([])[0],name:'mcp:release/delete',permission:'deny',readOnly:false}]},true],
    ['explicit model adapter',{tools:readonly(),runNode:async()=>({})},false],
    ['explicit judge adapter',{tools:readonly(),runJudge:async()=>({answers:{}})},false],
  ];
  for(const [name,options,expected] of cases){
    const {bridge,client}=await setup(t,options);
    assert.equal((await client.listTools()).tools[0].annotations.readOnlyHint,expected,name);
    assert.ok(bridge.catalog.every(tool=>!Object.hasOwn(tool,'readOnly')),'readOnly remains local callback metadata');
  }
});
