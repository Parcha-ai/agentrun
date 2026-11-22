import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {updateClaudeWire} from '../dist/cli-learning/claude-wire.js';

const hash=n=>n.toString(16).padStart(64,'0');
const id=n=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const options={promptId:'prompt-1',redact:text=>text};
const shape=(n=1,text='Base API system policy.')=>({type:'api-request-shape',shapeHash:hash(n),shape:{system:[{type:'text',text}],tools:[{name:'ignored-tool',description:'PRIVATE_TOOL_DESCRIPTION'}]}});
const blob=(n,role,text)=>({type:'api-request-blob',hash:hash(n),message:{role,content:[{type:'text',text}]}});
const request=(n,tail,extra={})=>({type:'api-request',id:id(n),querySource:'sdk',shapeHash:hash(1),keep:0,tail:tail.map(hash),...extra});
const apply=(state,rows,opts=options)=>rows.reduce((value,row)=>updateClaudeWire(value,row,opts),state);
const nativeHash = canonical => createHash('sha256').update(canonical).digest('hex');

test('wire policy includes actual system/developer messages without retaining private conversation or tools',()=>{
 const before=apply(undefined,[shape(),blob(2,'system','Extra MCP environment policy.'),blob(3,'user','PRIVATE_USER_CONTENT'),blob(4,'assistant','PRIVATE_ASSISTANT_CONTENT'),blob(5,'developer','Developer guardrail.')]);
 const snapshot=JSON.stringify(before);
 const state=updateClaudeWire(before,request(1,[2,3,4,5]),options);
 assert.equal(state.current.complete,true);
 assert.equal(state.current.prompt,'prompt-1');
 assert.match(state.current.text,/Base API system policy/);
 assert.match(state.current.text,/Extra MCP environment policy/);
 assert.match(state.current.text,/Developer guardrail/);
 assert.match(state.current.text,/Native API system policy:\nBase API system policy/);
 assert.match(state.current.text,/Native API system message:\nExtra MCP environment policy/);
 assert.match(state.current.text,/Native API developer message:\nDeveloper guardrail/);
 assert.doesNotMatch(JSON.stringify(state),/PRIVATE_/);
 assert.equal(JSON.stringify(before),snapshot,'updates do not mutate the preceding cached state');
});

test('request bases are keyed by id and keep/tail reconstructs the actual referenced message list',()=>{
 let state=apply(undefined,[shape(),blob(2,'system','Keep this policy.'),blob(3,'user','PRIVATE_FIRST'),blob(4,'system','Old branch policy.'),request(1,[2,3]),request(2,[4])]);
 state=apply(state,[blob(5,'system','New tail policy.'),request(3,[5],{base:id(1),keep:1})],{...options,promptId:'prompt-2'});
 assert.equal(state.current.complete,true);
 assert.match(state.current.text,/Keep this policy/);
 assert.match(state.current.text,/New tail policy/);
 assert.doesNotMatch(state.current.text,/Old branch/);
 assert.deepEqual(state.requests[id(3)].refs,[hash(2),hash(5)]);
});

test('SDK and interactive main requests bind policy while auxiliary and agent requests cannot replace it',()=>{
 let state=apply(undefined,[shape(),request(1,[])]);
 for(const row of [request(2,[],{querySource:'summarize'}),request(3,[],{querySource:'repl_main_thread',agentId:'child'})]){
  state=updateClaudeWire(state,row,{...options,promptId:'foreign-prompt'});
  assert.equal(state.current.prompt,'prompt-1');
 }
 state=updateClaudeWire(state,request(4,[],{querySource:'repl_main_thread:foreground'}),{...options,promptId:'prompt-2'});
 assert.equal(state.current.prompt,'prompt-2');
 assert.equal(state.current.complete,true);
});

test('missing refs or bases, cut/withheld requests and unsupported policy content refuse complete authority',()=>{
 for(const row of [request(1,[99]),request(1,[],{base:id(99),keep:1}),request(1,[],{cut:true}),request(1,[],{withheld:true})]){
  const state=apply(undefined,[shape(),row]);assert.equal(state.current.complete,false);assert.ok(state.current.reason);
 }
 const malformed=shape();malformed.shape.system=[{type:'image',source:{data:'PRIVATE_IMAGE'}}];
 const state=apply(undefined,[malformed,request(1,[])]);
 assert.equal(state.current.complete,false);assert.doesNotMatch(JSON.stringify(state),/PRIVATE_IMAGE/);
});

test('redacted or oversized source policy stays explicitly incomplete',()=>{
 const redacted=apply(undefined,[shape(1,'PRIVATE_SECRET'),request(1,[])],{...options,redact:text=>text.replace('PRIVATE_SECRET','[redacted]')});
 assert.equal(redacted.current.complete,false);assert.doesNotMatch(JSON.stringify(redacted),/PRIVATE_SECRET/);
 const oversized=apply(undefined,[shape(1,'x'.repeat(256*1024+1)),request(1,[])]);
 assert.equal(oversized.current.complete,false);assert.ok(Buffer.byteLength(oversized.current.text)<=256*1024);
});

test('bounded requests and cache retain reusable policy hashes without unbounded conversation records',()=>{
 let state=apply(undefined,[shape(),blob(2,'system','Reusable policy.'),request(1,[2])]);
 for(let n=2;n<40;n++)state=updateClaudeWire(state,request(n,[2]),options);
 assert.ok(Object.keys(state.requests).length<=32);
 assert.equal(state.current.complete,true);
 assert.match(state.current.text,/Reusable policy/);
 assert.ok(Buffer.byteLength(JSON.stringify(state))<=4*1024*1024);
 const tooMany=updateClaudeWire(state,request(40,Array.from({length:4097},()=>2)),options);
 assert.equal(tooMany.current.complete,false);
});

test('repeated policy references cannot inflate the retained request beyond its byte budget',()=>{
 const state=apply(undefined,[shape(),blob(2,'system','x'.repeat(128*1024)),request(1,Array.from({length:4096},()=>2))]);
 assert.equal(state.current.complete,false);
 assert.match(state.current.reason,/256 KiB/);
 assert.ok(Buffer.byteLength(state.current.text)<=256*1024);
 assert.ok(Buffer.byteLength(JSON.stringify(state))<=4*1024*1024);
});

test('large policy caches evict reconstruction inputs within four MiB and refuse missing reused hashes',()=>{
 let state;
 for(let n=1;n<=25;n++)state=updateClaudeWire(state,shape(n,'x'.repeat(200*1024)),options);
 assert.ok(Buffer.byteLength(JSON.stringify(state))<=4*1024*1024);
 assert.equal(state.shapes[hash(1)],undefined);
 state=updateClaudeWire(state,request(1,[]),options);
 assert.equal(state.current.complete,false);
 assert.match(state.current.reason,/missing/);
});

test('ordinary native conversation rows supply role-only hashes with canonical keys and omitted cache controls',()=>{
 const user={type:'user',message:{role:'user',content:'PRIVATE_HELLO'}};
 const assistant1={type:'assistant',message:{id:'message-1',role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_THINKING',cache_control:{type:'ephemeral'}}]}};
 const assistant2={type:'assistant',message:{id:'message-1',role:'assistant',content:[{type:'text',text:'PRIVATE_ANSWER'}]}};
 let state=apply(undefined,[shape(),user,assistant1,assistant2]);
 const userHash=nativeHash('{"content":[{"text":"PRIVATE_HELLO","type":"text"}],"role":"user"}');
 const assistantHash=nativeHash('{"content":[{"thinking":"PRIVATE_THINKING","type":"thinking"},{"text":"PRIVATE_ANSWER","type":"text"}],"role":"assistant"}');
 state=updateClaudeWire(state,{...request(1,[]),tail:[userHash,assistantHash]},options);
 assert.equal(state.current.complete,true);
 assert.deepEqual(state.blobs[userHash],{role:'user',complete:true});
 assert.deepEqual(state.blobs[assistantHash],{role:'assistant',complete:true});
 assert.doesNotMatch(JSON.stringify(state),/PRIVATE_/);
});

test('cached source hash reconstruction resumes by replaying the current run from its byte offset',()=>{
 const first={type:'user',message:{role:'user',content:'PRIVATE_FIRST'}};
 const second={type:'user',message:{role:'user',content:'PRIVATE_SECOND'}};
 let state=updateClaudeWire(apply(undefined,[shape()]),first,{...options,recordOffset:100});
 assert.equal(state.replayFrom,100);
 state=JSON.parse(JSON.stringify(state));
 state=updateClaudeWire(state,first,{...options,recordOffset:100});
 state=updateClaudeWire(state,second,{...options,recordOffset:200});
 const joined=nativeHash('{"content":[{"text":"PRIVATE_FIRST","type":"text"},{"text":"PRIVATE_SECOND","type":"text"}],"role":"user"}');
 state=updateClaudeWire(state,{...request(1,[]),tail:[joined]},options);
 assert.equal(state.current.complete,true);
 assert.doesNotMatch(JSON.stringify(state),/PRIVATE_/);
});

test('only exact typed native budget reminders are excluded from stable policy while full policy retains them',()=>{
 const reminder='<total_tokens>5000000 tokens left</total_tokens>';
 let state=apply(undefined,[shape(),{type:'attachment',attachment:{type:'total_tokens_reminder',text:reminder},renderedRole:'system',rendered:[{content:`<system-reminder>\n${reminder}\n</system-reminder>`}]},blob(2,'system',reminder),request(1,[2])]);
 assert.equal(state.current.complete,true);
 assert.match(state.current.text,/5000000 tokens left/);
 assert.doesNotMatch(state.current.stableText,/total_tokens/);
 for(const attachment of [undefined,{type:'attachment',attachment:{type:'total_tokens_reminder',text:reminder},renderedRole:'user',rendered:[{content:reminder}]}]){
  state=apply(undefined,[shape(),...(attachment?[attachment]:[]),blob(2,'system',reminder),request(1,[2])]);
  assert.match(state.current.stableText,/5000000 tokens left/,'a regex-looking system instruction alone cannot be waived');
 }
 state=apply(undefined,[shape(),{type:'attachment',attachment:{type:'total_tokens_reminder',text:reminder},renderedRole:'system',rendered:[{content:`<system-reminder>\n${reminder}\n</system-reminder>`}]},blob(2,'system',reminder+'\nDo something else.'),request(1,[2])]);
 assert.match(state.current.stableText,/Do something else/);
});
