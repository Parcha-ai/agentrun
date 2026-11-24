import assert from 'node:assert/strict';
import { test } from 'node:test';
import fsSync, { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { scratch } from './support.mjs';
import { claudeSession, codexSession, sessionId } from './fixtures/import-sessions.mjs';
import { exportRemoteHistory } from '../dist/import.js';

async function fixture(t, runtime) {
 const root=await scratch(t),home=join(root,'home'),project=join(home,'selected');
 mkdirSync(project,{recursive:true});
 return {root,home,project,target:{runtime,project,selector:{kind:'project'}},options:{home,env:{}},make:runtime==='claude-code'?claudeSession:codexSession};
}

for(const changed of ['id','cwd']) {
 test(`codex: a later ${changed} change is refused by the authoritative page parse`,async t=>{
  const f=await fixture(t,'codex'),file=f.make(f.home,f.project,1,{prompt:'Changed transcript must remain local.'}),before=statSync(file);
  const payload={id:sessionId(1),cwd:f.project};
  payload[changed]=changed==='id'?sessionId(99):join(f.home,'unapproved');
  appendFileSync(file,JSON.stringify({type:'session_meta',payload})+'\n');utimesSync(file,before.atime,before.mtime);
  const preview=await exportRemoteHistory(f.target,{...f.options,preview:true});
  const page=await exportRemoteHistory(f.target,{...f.options,inventory:preview.inventory});
  assert.deepEqual(page.sessions,[]);assert.ok(page.skipped.some(s=>/changed during export/.test(s.reason)));
  assert.doesNotMatch(JSON.stringify(page),/Changed transcript|unapproved/);
 });
}

for(const runtime of ['claude-code','codex']) {
 test(`${runtime}: history pagination parses each selected transcript only on its page`,async t=>{
  const f=await fixture(t,runtime),files=[];
  for(let n=1;n<=45;n++)files.push(f.make(f.home,f.project,n));
  const unrelated=join(f.home,'unrelated');mkdirSync(unrelated,{recursive:true});
  const outside=f.make(f.home,unrelated,99,{prompt:'Unapproved unrelated conversation.'});
  const reads=new Map();let metadataBytes=0;
  const stream=fsSync.createReadStream,open=fs.open;
  const streamMock=t.mock.method(fsSync,'createReadStream',(...args)=>{
   reads.set(args[0],(reads.get(args[0])??0)+1);return stream(...args);
  });
  const openMock=t.mock.method(fs,'open',async (...args)=>{
   const handle=await open(...args),read=handle.read.bind(handle);
   t.mock.method(handle,'read',async (...args)=>{const result=await read(...args);metadataBytes+=result.bytesRead;return result;});
   return handle;
  });
  syncBuiltinESMExports();t.after(()=>{streamMock.mock.restore();openMock.mock.restore();syncBuiltinESMExports();});
  const count=()=>[...reads.values()].reduce((sum,n)=>sum+n,0),counts=[],ids=[];
  const preview=await exportRemoteHistory(f.target,{...f.options,preview:true});counts.push(count());
  assert.equal(preview.total,45);assert.deepEqual(preview.sessions,[]);
  let cursor=0;
  do {
   const page=await exportRemoteHistory(f.target,{...f.options,cursor,inventory:preview.inventory});
   assert.equal(page.inventory,preview.inventory);assert.equal(page.total,45);assert.deepEqual(page.skipped,[]);
   ids.push(...page.sessions.map(s=>s.id));counts.push(count());cursor=page.next_cursor;
  } while(cursor!==null);
  assert.deepEqual(ids,Array.from({length:45},(_,n)=>sessionId(n+1)));
  assert.deepEqual(counts,[0,20,40,45],'preview and later pages must not stream all selected transcripts again');
  assert.equal(reads.get(outside)??0,0,'unrelated transcript bodies are never parsed');
  assert.ok(files.every(file=>reads.get(file)===1),'each selected body is read once across all pages');
  assert.ok(metadataBytes>0 && metadataBytes<=4*46*64*1024,'inventory checks read bounded metadata records');
 });

 test(`${runtime}: a later-page replacement needs fresh inventory approval before its body is read`,async t=>{
  const f=await fixture(t,runtime);for(let n=1;n<=21;n++)f.make(f.home,f.project,n);
  const file=f.make(f.home,f.project,21,{prompt:'Approved prompt.'}),before=statSync(file);
  const preview=await exportRemoteHistory(f.target,{...f.options,preview:true});
  const first=await exportRemoteHistory(f.target,{...f.options,inventory:preview.inventory});assert.equal(first.next_cursor,20);
  const replacement=join(f.root,'replacement.jsonl');writeFileSync(replacement,readFileSync(file,'utf8').replaceAll('Approved prompt.','Unwanted secret.'));
  utimesSync(replacement,before.atime,before.mtime);renameSync(replacement,file);
  assert.equal(statSync(file).size,before.size);assert.equal(statSync(file).mtimeMs,before.mtimeMs);assert.notEqual(statSync(file).ino,before.ino);
  let reads=0;const stream=fsSync.createReadStream;
  const mocked=t.mock.method(fsSync,'createReadStream',(...args)=>{reads++;return stream(...args);});
  syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
  await assert.rejects(exportRemoteHistory(f.target,{...f.options,cursor:20,inventory:preview.inventory}),/inventory changed/);
  assert.equal(reads,0,'unapproved later-page bodies are not parsed before the inventory comparison');
  const fresh=await exportRemoteHistory(f.target,{...f.options,preview:true});assert.notEqual(fresh.inventory,preview.inventory);
  const page=await exportRemoteHistory(f.target,{...f.options,cursor:20,inventory:fresh.inventory});
  assert.equal(page.sessions.length,1);assert.equal(page.sessions[0].firstPrompt,'Unwanted secret.');
 });

 test(`${runtime}: a child marker after opening metadata cannot export a standalone session`,async t=>{
  const f=await fixture(t,runtime),file=f.make(f.home,f.project,1),before=statSync(file);
  const child=runtime==='claude-code'?{type:'progress',isSidechain:true}:{type:'session_meta',payload:{id:sessionId(1),cwd:f.project,parent_thread_id:sessionId(99)}};
  appendFileSync(file,JSON.stringify(child)+'\n');utimesSync(file,before.atime,before.mtime);
  const preview=await exportRemoteHistory(f.target,{...f.options,preview:true});
  const page=await exportRemoteHistory(f.target,{...f.options,inventory:preview.inventory});
  assert.deepEqual(page.sessions,[]);assert.ok(page.skipped.some(s=>/Subagent history/.test(s.reason)));
 });

 test(`${runtime}: split metadata, resumed copies and the EOF filename fallback keep each session's identity`,async t=>{
  const f=await fixture(t,runtime),file=f.make(f.home,f.project,1,{prompt:'Known selected prompt.'}),before=statSync(file);
  const rows=readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  if(runtime==='claude-code')delete rows[0].sessionId;
  else {
   delete rows[0].payload.id;
   rows.splice(1,0,{type:'session_meta',payload:{id:sessionId(1),cwd:f.project}});
  }
  writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');utimesSync(file,before.atime,before.mtime);
  const copy=join(dirname(file),runtime==='claude-code'?'resumed-copy.jsonl':'rollout-resumed-copy.jsonl');
  copyFileSync(file,copy);utimesSync(copy,before.atime,before.mtime);
  const fallback=f.make(f.home,f.project,2),fallbackStat=statSync(fallback);
  const noIds=readFileSync(fallback,'utf8').trim().split('\n').map(line=>{
   const row=JSON.parse(line);if(runtime==='claude-code')delete row.sessionId;else if(row.type==='session_meta')delete row.payload.id;return row;
  });
  writeFileSync(fallback,noIds.map(row=>JSON.stringify(row)).join('\n')+'\n');utimesSync(fallback,fallbackStat.atime,fallbackStat.mtime);
  // A Codex rollout resumed in a new file keeps its thread's id: one session. Claude Code names each session's file for
  // its id, and a resumed session's new file restamps the records it copies with its own: the file's name is the id, so a
  // file under another name is another session, whatever ids its records carry.
  const ids=[sessionId(1),basename(fallback,'.jsonl'),...(runtime==='claude-code'?[basename(copy,'.jsonl')]:[])].sort();
  const preview=await exportRemoteHistory(f.target,{...f.options,preview:true});assert.equal(preview.total,ids.length);
  const page=await exportRemoteHistory(f.target,{...f.options,inventory:preview.inventory});
  assert.deepEqual(page.skipped,[]);assert.deepEqual(page.sessions.map(s=>s.id).sort(),ids);
  assert.equal(page.sessions.find(s=>s.id===sessionId(1)).firstPrompt,'Known selected prompt.');
 });
}
