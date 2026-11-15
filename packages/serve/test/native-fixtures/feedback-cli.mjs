#!/usr/bin/env node
// A completed source task and a notes-only "No change." reflection; no intentional hang substring sentinel.
import {appendFileSync,readFileSync} from 'node:fs';
import {basename} from 'node:path';
const claude=basename(process.argv[1])==='claude',args=process.argv.slice(2);
appendFileSync(process.env.NATIVE_TEST_LOG,JSON.stringify({args})+'\n');
if(args.includes('--version')){console.log(claude?'2.1.322 (Claude Code)':'codex-cli 0.167.2');process.exit(0);}
if(args.includes('status')){console.log(claude?'{"loggedIn":true}':'Logged in');process.exit(0);}
if(args.includes('mcp')&&args.includes('list')){console.log('[]');process.exit(0);}
const prompt=readFileSync(0,'utf8'),answer=prompt.startsWith('The task is done.')?'No change.':'native answer';
const id='22222222-2222-4222-8222-222222222222';
const rows=claude?[{type:'system',subtype:'init',session_id:id},{type:'assistant',message:{content:[{type:'text',text:answer}]}},{type:'result',subtype:'success',session_id:id,result:answer,usage:{input_tokens:7,output_tokens:3,cache_read_input_tokens:0},total_cost_usd:args.includes('--resume')?0.02:0.01}]:[{type:'thread.started',thread_id:id},{type:'item.completed',item:{id:'answer',type:'agent_message',text:answer}},{type:'turn.completed',usage:{input_tokens:9,output_tokens:4,cached_input_tokens:0}}];
for(const row of rows)console.log(JSON.stringify(row));
