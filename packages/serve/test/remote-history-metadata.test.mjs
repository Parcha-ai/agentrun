import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync, utimesSync, truncateSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { READERS } from '@parcha/agentrun-import';
import { scratch } from './support.mjs';
import { claudeSession, codexSession, copilotSession } from './fixtures/import-sessions.mjs';
import { exportRemoteHistory } from '../dist/import.js';
import { remoteHistorySessions } from '../dist/native/history.js';

async function fixture(t) {
 const root=await scratch(t),home=join(root,'home'),project=join(home,'selected');
 mkdirSync(project,{recursive:true});
 return {root,home,project,target:{runtime:'claude-code',project,selector:{kind:'project'}},options:{home,env:{}}};
}

test('a large first Claude record is included in the approved selected-project inventory and exported intact',async t=>{
 const f=await fixture(t),prompt='Use the supplied context: '+'é'.repeat(78_000)+' End of supplied context.';
 const file=claudeSession(f.home,f.project,1,{prompt}),before=readFileSync(file);
 assert.ok(Buffer.byteLength(before.toString('utf8').split('\n')[0])>128*1024);
 const other=join(f.home,'unrelated');mkdirSync(other,{recursive:true});
 claudeSession(f.home,other,2,{prompt:'Unrelated secret '+'x'.repeat(150_000)});
 const preview=await exportRemoteHistory(f.target,{...f.options,preview:true});
 assert.equal(preview.total,1);assert.deepEqual(preview.skipped,[]);assert.deepEqual(preview.sessions,[]);
 const exported=await exportRemoteHistory(f.target,{...f.options,inventory:preview.inventory});
 assert.equal(exported.sessions.length,1);assert.equal(exported.sessions[0].turns[0].text,prompt);
 assert.deepEqual(exported.skipped,[]);assert.doesNotMatch(JSON.stringify(exported),/Unrelated secret/);
 remoteHistorySessions({sessions:exported.sessions},'claude-code');
 assert.deepEqual(readFileSync(file),before,'source bytes are untouched');
});

test('uncheckable project metadata is reported instead of silently omitted',async t=>{
 const f=await fixture(t),file=claudeSession(f.home,f.project,1);
 writeFileSync(file,'{"unfinished":"'+'x'.repeat(8_000_001));
 const old=new Date(Date.now()-3600_000);utimesSync(file,old,old);
 let bytesRead=0;
 const originalOpen=fs.open;
 const mocked=t.mock.method(fs,'open',async (...args)=>{
  const handle=await originalOpen(...args);
  if(args[0]===file){
   const read=handle.read.bind(handle);
   t.mock.method(handle,'read',async (...args)=>{const result=await read(...args);bytesRead+=result.bytesRead;return result;});
  }
  return handle;
 });
 syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
 const preview=await exportRemoteHistory(f.target,{...f.options,preview:true});
 assert.equal(bytesRead,8_000_000,'metadata reads stop at the remote source-size bound');
 assert.equal(preview.total,0);assert.deepEqual(preview.sessions,[]);
 assert.equal(preview.skipped.reduce((n,s)=>n+s.count,0),1);
 assert.match(preview.skipped[0].reason,/project.*could not be checked/i);
 assert.doesNotMatch(JSON.stringify(preview),/unfinished|selected|jsonl/);
});

test('an unreadable JSON metadata record is reported without including its contents',async t=>{
 const f=await fixture(t),file=claudeSession(f.home,f.project,1);
 writeFileSync(file,'{"secret":"PRIVATE-CANARY"\n');
 const preview=await exportRemoteHistory(f.target,{...f.options,preview:true});
 assert.equal(preview.total,0);assert.equal(preview.skipped.reduce((n,s)=>n+s.count,0),1);
 assert.match(preview.skipped[0].reason,/project.*could not be checked/i);
 assert.doesNotMatch(JSON.stringify(preview),/PRIVATE-CANARY|secret/);
});

for (const [runtime, makeSession] of [['claude-code', claudeSession], ['codex', codexSession]]) {
 test(`${runtime}: oversized selected sessions only get a bounded metadata probe during preview and every export page`,async t=>{
  const f=await fixture(t),target={...f.target,runtime};
  for(let n=1;n<=21;n++)makeSession(f.home,f.project,n);
  const oversized=makeSession(f.home,f.project,99);
  truncateSync(oversized,8_000_001);
  const old=new Date(Date.now()-3600_000);utimesSync(oversized,old,old);
  const before=statSync(oversized);
  // Bodies counted where the importer reads them (READERS[source].read), however it reads the bytes; opens made inside
  // a body read are the body's, so metadataBytes is serve's own probe.
  let transcriptReads=0,bodyReads=0,metadataBytes=0;
  const body=new AsyncLocalStorage(),reader=READERS[runtime],readBody=reader.read,open=fs.open;
  const readMock=t.mock.method(reader,'read',function(at,...rest){
   bodyReads++;if(at.file===oversized)transcriptReads++;
   return body.run(true,()=>readBody.call(this,at,...rest));
  });
  const openMock=t.mock.method(fs,'open',async (...args)=>{
   const handle=await open(...args);
   if(args[0]===oversized && !body.getStore()){
    const read=handle.read.bind(handle);
    t.mock.method(handle,'read',async (...args)=>{const result=await read(...args);metadataBytes+=result.bytesRead;return result;});
   }
   return handle;
  });
  syncBuiltinESMExports();t.after(()=>{readMock.mock.restore();openMock.mock.restore();syncBuiltinESMExports();});
  const preview=await exportRemoteHistory(target,{...f.options,preview:true});
  assert.equal(transcriptReads,0,'preview must reject the oversized transcript before parsing it');
  assert.equal(preview.total,21);
  assert.deepEqual(preview.skipped,[{reason:'Source session file exceeds the remote import size limit.',count:1}]);
  const first=await exportRemoteHistory(target,{...f.options,inventory:preview.inventory});
  assert.equal(bodyReads,20,'the body-read counter sees the first page read its 20 bodies');
  assert.equal(transcriptReads,0,'the first page must not parse a transcript it cannot export');
  assert.equal(first.sessions.length,20);assert.equal(first.next_cursor,20);
  const last=await exportRemoteHistory(target,{...f.options,inventory:preview.inventory,cursor:first.next_cursor});
  assert.equal(transcriptReads,0,'later pages must not rescan the oversized transcript');
  assert.equal(last.sessions.length,1);assert.equal(last.next_cursor,null);
  assert.ok(metadataBytes>0 && metadataBytes<=3*64*1024,'only one metadata chunk per enumeration is read');
  const after=statSync(oversized);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);
 });
}

test('copilot: a session names its project in session.start, and a run the CLI started on another session\'s exit is a child', async t => {
 const f=await fixture(t),target={...f.target,runtime:'copilot'};
 const file=copilotSession(f.home,f.project,1);
 const child=copilotSession(f.home,f.project,2);
 writeFileSync(child,readFileSync(child,'utf8').replace('"sessionId"','"detachedFromSpawningParentSessionId":"00000000-0000-4000-8000-000000000001","sessionId"'));
 const old=new Date(Date.now()-3600_000);utimesSync(child,old,old);
 copilotSession(f.home,join(f.home,'unrelated'),3);
 const preview=await exportRemoteHistory(target,{...f.options,preview:true});
 assert.equal(preview.total,1);
 assert.deepEqual(preview.skipped,[{reason:'Subagent history is not a separate session.',count:1}]);
 assert.ok(readFileSync(file).length>0);
});
