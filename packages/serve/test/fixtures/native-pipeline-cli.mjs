#!/usr/bin/env node
// Scripted native process boundary: the actual store, end-of-run step and learning commit remain real.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli 0.167.2');process.exit(0);}
if(args[0]==='login'){
 if(existsSync(join(process.env.CODEX_HOME,'verify-wait'))){writeFileSync(join(process.env.CODEX_HOME,'verify-started'),'yes');while(!existsSync(join(process.env.CODEX_HOME,'verify-release')))await new Promise(r=>setTimeout(r,25));}
 process.stderr.write('Logged in using ChatGPT\n');process.exit(0);
}
if(args.includes('mcp')&&args.includes('list')){console.log('[]');process.exit(0);}
const prompt=readFileSync(0,'utf8');
const resume=args.indexOf('resume');const session=resume<0?randomUUID():args[resume+2];
const path=join(process.env.CODEX_HOME,`fixture-${session}.json`);
let before={turn:0};try{before=JSON.parse(readFileSync(path,'utf8'));}catch{}
const turn=before.turn+1;writeFileSync(path,JSON.stringify({turn}));
let scenario='plain';try{scenario=readFileSync(join(process.env.CODEX_HOME,'scenario'),'utf8');}catch{}
appendFileSync(join(process.env.CODEX_HOME,'fixture-calls.jsonl'),JSON.stringify({session,turn,prompt,cwd:process.cwd()})+'\n');
let answer=prompt.includes('Launch state')?'Launch state: ready':'ready';
if(scenario==='output-retry-no-usage'&&turn>1)process.exit(1);
if(scenario==='output-retry'&&turn>1)answer='```json\n{"ready":true}\n```';
if(scenario==='blocked')while(!existsSync(join(process.env.CODEX_HOME,'release-task')))await new Promise(r=>setTimeout(r,25));
if(scenario==='output-denied')console.log(JSON.stringify({type:'item.completed',item:{id:'denied',type:'command_execution',command:'blocked',status:'declined'}}));
for(const row of [{type:'thread.started',thread_id:session},{type:'item.completed',item:{id:'answer',type:'agent_message',text:answer}},{type:'turn.completed',usage:{input_tokens:100*turn,output_tokens:20*turn,...(scenario==='unknown-cache'?{}:{cached_input_tokens:scenario.startsWith('cache-write')?30:0}),...(scenario==='cache-write-known'?{cache_write_input_tokens:20}:{})}}])console.log(JSON.stringify(row));
if(scenario==='failed-usage')process.exitCode=1;
