// Real SDK HTTP receipt, compile cadence/checker and booked provider requests. Only the model's answers are scripted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { serve, client } from "./support.mjs";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { journalEntries } from "../dist/runner/journal-reader.js";
import { reflectRequestId } from "../dist/runner/end-of-run.js";
import { SHAPE_LINE } from "../dist/learn/compile.js";
const tool = { name: "mcp:backend/status", description: "Takes release and returns its ready boolean.", input_schema: { type: "object", properties: { release: { type: "string" } }, required: ["release"] }, output_schema: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] }, permission: "allow", price_usd: 0 };
const workflow = { v: 2, name: "release-status", schemas: { Input: tool.input_schema, Status: tool.output_schema }, input: { schemaId: "Input" }, output: { schemaId: "Status", path: "status" }, root: { node: "call", label: "status", via: "tool", tool: tool.name, args: { release: "{release}" }, out: "Status", as: "status", deadline_s: 5 } };
const answer = '````workflow release-status\n---\ndescription: Return release readiness using the existing backend tool.\nexample: {"release":"current"}\n---\n' + JSON.stringify(workflow) + '\n````';
function route(sent) {
 return { provider: { api: "anthropic-messages", origin: "https://scripted-compiler.invalid", credential: () => "scripted-compiler-credential" }, model: "scripted-compiler", price: () => 0.05, fetch: async (_url, init) => {
  const body=JSON.parse(String(init.body));sent.push(body);
  const prompt=body.messages.map(m=>typeof m.content==="string"?m.content:m.content.map(p=>p.text??"").join("\n")).join("\n");
  const compile=prompt.startsWith("One more turn:")||prompt.startsWith("Your workflow draft did not pass the checks");
  let text="No notes.";
  if(compile){
   assert.ok(prompt.includes(SHAPE_LINE),"the compiler receives the SDK revision's required output shape");
   assert.match(prompt,/NO runNode/);assert.match(prompt,/NO runJudge/);assert.match(prompt,/mcp:backend\/status/);assert.match(prompt,/Takes release/);assert.match(prompt,/ready/);assert.match(prompt,/explicit.*bridge/i);
   assert.doesNotMatch(prompt,/on later runs it runs first/);
   text=prompt.includes("MALFORMED-SDK-COMPILE")?answer:"MALFORMED-SDK-COMPILE";
  }
  const events=[{type:"message_start",message:{id:"compiler",type:"message",role:"assistant",model:"scripted-compiler",content:[],stop_reason:null,usage:{input_tokens:20,output_tokens:0}}},{type:"content_block_start",index:0,content_block:{type:"text",text:""}},{type:"content_block_delta",index:0,delta:{type:"text_delta",text}},{type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:10}},{type:"message_stop"}];
  return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
 } };
}
for(const runtime of ["claude-agent-sdk","codex-sdk"])test(`${runtime} real compile threshold, malformed retry and reclaimed end preserve request identity and cost once`,async t=>{
 const s=await serve(t,{runner:false}),id="sdk-compiler";
 assert.equal((await s.api("POST","/agents",{definition:{id,name:id,instructions:"Report release readiness using the declared backend callback.",sdk:{runtime},learning:true,tools:[],output_schema:tool.output_schema}})).status,201);
 const sent=[],grader=route(sent);
 const settle=async(runId,crash=false)=>{
  const claim=await s.store.claim(runId,"sdk-compiler-proof",{leaseMs:60_000});assert.ok(claim);
  const launch=(await s.store.runs.launch(runId)).body,abort=new AbortController(),journal=s.store.journal(claim);let cut=false;
  const guarded=new Proxy(journal,{get(target,key){const value=Reflect.get(target,key,target);if(key==="commit"&&crash)return async(batches,...rest)=>{
   if(batches.flat().some(w=>w.type==="entry"&&w.value.kind==="agentrun.end")){cut=true;abort.abort();throw new Error("crash after durable compiler answer before atomic end");}
   return value.call(target,batches,...rest);
  };return typeof value==="function"?value.bind(target):value;}});
  const loop=createSdkLoop(launch,{store:s.store,data:s.data,env:{},sealKey:Buffer.alloc(32,7)},async()=>grader)({journal:()=>guarded,flush:()=>s.store.flush(),signal:abort.signal});
  const result=await loop.start(claim);assert.equal(result.state,crash?"interrupted":"ended",JSON.stringify(result));
  if(crash){assert.ok(cut);await s.store.release(claim);}
 };
 let runId, sdk;
 for(let n=0;n<5;n++){
  const start=await s.api("POST",`/agents/${id}/sdk-runs`,{runtime,input:`Check release ${n}.`,instructions:"Report release readiness using the declared backend callback.",workflow_tools:[tool]}, {"Idempotency-Key":`compile-${n}`});assert.equal(start.status,201,JSON.stringify(start.body));runId=start.body.run_id;
  sdk=client(s.baseUrl,start.body.token);
  const done=await sdk("POST",`/sdk-runs/${runId}/complete`,{status:"completed",answer:'{"ready":true}',usage:{cost_usd:0.25,input_tokens:20,output_tokens:5,cache_read_tokens:0,cache_write_tokens:0}});assert.equal(done.status,200);
  await settle(runId,n===4);
  if(n<4)assert.equal(sent.length,n+1,"before the real five-run threshold there is only the look-back");
 }
 const before=await journalEntries(s.store.readJournal(runId),BACKGROUND_CONTEXT);
 const prompts=before.filter(e=>e.kind==="agentrun.end-of-run.turn"&&e.data.role==="person");
 assert.deepEqual(prompts.map(e=>e.data.requestId),[reflectRequestId(runId),reflectRequestId(runId,false,1,"compile-1"),reflectRequestId(runId,false,1,"compile-2")]);
 assert.equal(before.filter(e=>e.kind==="agentrun.end-of-run.turn"&&e.data.role==="model").length,3);
 assert.equal(await s.store.learning.proposal(runId),undefined,"proposal and end remain atomic through the crash");
 const requests=sent.length;assert.equal(requests,7,"four earlier look-backs, then look-back and two actual compiler requests");
 await settle(runId);
 assert.equal(sent.length,requests,"reclaim reuses all durable answers, with no repeated paid request");
 const kept=await s.store.learning.proposal(runId);assert.equal(kept.proposal.state,"proposed",JSON.stringify(kept.proposal));
 assert.deepEqual(kept.proposal.compiled.attempts.map(a=>a.ok),[false,true]);
 assert.ok(kept.proposal.proposal.files.some(f=>f.file==="workflows/release-status/workflow.json"));
 const view=await sdk("GET",`/sdk-runs/${runId}`);assert.equal(view.status,200,JSON.stringify(view.body));
 assert.deepEqual(view.body.learning.compiled.attempts.map(a=>a.ok),[false,true],"the actual SDK HTTP learning response retains both compiler attempts");
 assert.equal(view.body.learning.compiled.digest,kept.proposal.compiled.digest);assert.deepEqual(view.body.learning.draft_errors,[],"the HTTP contract reports no remaining draft errors after correction");
 assert.equal(kept.proposal.job_cost_usd,0.25);assert.ok(Math.abs(kept.proposal.look_back_usd-0.15)<1e-9);
 assert.ok(Math.abs((await s.store.runs.get(runId)).costUsd-0.4)<1e-9,"task plus exactly three learning charges");
});
