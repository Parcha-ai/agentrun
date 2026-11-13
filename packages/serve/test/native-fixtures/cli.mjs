#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
const runtime = basename(process.argv[1]);
const args = process.argv.slice(2);
if (process.env.NATIVE_TEST_LOG) appendFileSync(process.env.NATIVE_TEST_LOG, JSON.stringify({runtime,args,cwd:process.cwd(),home:process.env.HOME,codexHome:process.env.CODEX_HOME})+'\n');
if (args.includes('--version')) { console.log(process.env.NATIVE_TEST_VERSION ?? (runtime === 'claude' ? '2.1.322 (Claude Code)' : 'codex-cli 0.167.2')); process.exit(0); }
if (args.includes('status')) { console.log(runtime === 'claude' ? JSON.stringify({loggedIn:process.env.NATIVE_TEST_AUTH !== 'no'}) : process.env.NATIVE_TEST_AUTH === 'no' ? 'Not logged in' : 'Logged in using ChatGPT'); process.exit(process.env.NATIVE_TEST_AUTH === 'no' ? 1 : 0); }
if(args.includes('mcp')&&args.includes('list')){console.log(JSON.stringify([{name:'docs',enabled:!args.includes('mcp_servers.docs.enabled=false'),transport:{type:'stdio'}},{name:'inline-only',enabled:!args.includes('mcp_servers.inline-only.enabled=false'),transport:{type:'streamable_http'}}]));process.exit(0);}
const prompt=readFileSync(0,'utf8');
if(process.env.NATIVE_TEST_INPUT_LOG)appendFileSync(process.env.NATIVE_TEST_INPUT_LOG,JSON.stringify({runtime,prompt})+'\n');
if(process.env.NATIVE_TEST_MALFORMED==='yes'){console.log('invalid native protocol');process.exit(0);}
if (prompt.includes('hang')) { setInterval(()=>{},1000); } else {
 const sessionId=runtime==='claude'?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222';
 const emit=(x)=>{console.log(JSON.stringify(x));if(process.env.NATIVE_TEST_DUPLICATE==='yes')console.log(JSON.stringify(x));};
 if(runtime==='claude') {
  emit({type:'system',subtype:'init',session_id:sessionId,model:'native-claude'});
  emit({type:'assistant',message:{content:[{type:'text',text:'native answer'}]}});
  emit({type:'result',subtype:'success',session_id:sessionId,result:'native answer',usage:{input_tokens:7,output_tokens:3,cache_read_input_tokens:2},total_cost_usd:args.includes('--resume')?0.03:0.01,permission_denials:process.env.NATIVE_TEST_DENY==='yes'?[{tool_name:'Bash',tool_use_id:'tool-denied',tool_input:{command:'blocked'}}]:[]});
 } else {
  emit({type:'thread.started',thread_id:sessionId});
  emit({type:'item.completed',item:{id:'message-1',type:'agent_message',text:'native answer'}});
  emit({type:'turn.completed',usage:args.includes('resume')?{input_tokens:19,output_tokens:7,cached_input_tokens:3}:{input_tokens:9,output_tokens:4,cached_input_tokens:2}});
 }
}
