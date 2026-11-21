import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureTranscriptCursor } from '../dist/cli-learning/evidence.js';
import { readTranscriptPolicy } from '../dist/cli-learning/policy.js';
const rows = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';

const wireRows = (extra = 'MCP policy: preserve source permissions.', source = 'sdk', suffix = 'one') => [
  { type: 'api-request-shape', sessionId: 'session', shapeHash: 'a'.repeat(64), shape: { system: [{ type: 'text', text: 'Exact native base policy.' }], tools: [] } },
  { type: 'api-request-blob', sessionId: 'session', hash: 'b'.repeat(64), message: { role: 'system', content: [{ type: 'text', text: extra }] } },
  { type: 'api-request-blob', sessionId: 'session', hash: 'c'.repeat(64), message: { role: 'user', content: 'PRIVATE PRIOR CONVERSATION' } },
  { type: 'api-request', sessionId: 'session', id: suffix === 'one' ? '00000000-0000-0000-0000-000000000001' : '00000000-0000-0000-0000-000000000002', querySource: source, shapeHash: 'a'.repeat(64), keep: 0, tail: ['b'.repeat(64), 'c'.repeat(64)] },
];

const developer = text => ({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } });
async function fixture(t, runtime = 'codex') {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-source-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.jsonl'), cachePath = join(dir, 'policy.json');
  await writeFile(path, runtime === 'codex' ? rows([{ type: 'session_meta', payload: { id: 'session', base_instructions: { text: 'Native base policy' } } }]) : '');
  return { path, cachePath, append: values => appendFile(path, rows(values)), read: async extra => readTranscriptPolicy({ runtime, cursor: await captureTranscriptCursor(path), cachePath, sessionId: 'session', budgetMs: 5000, ...extra }) };
}
test('long sessions inspect only policy, reset obsolete developer policy on compaction, and continue from a private checkpoint', async t => {
  const f = await fixture(t);
  await f.append([developer('Obsolete developer policy'), ...Array.from({length: 1100}, () => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'PRIVATE HISTORY ' + 'x'.repeat(8192) } }))]);
  await f.append([{ type: 'compacted', payload: { replacement_history: [developer('Current retained developer policy').payload] } }]);
  const result = await f.read();
  assert.equal(result.incomplete, undefined);
  assert.match(result.text, /Native base policy/);
  assert.match(result.text, /Current retained developer policy/);
  assert.doesNotMatch(result.text, /Obsolete|PRIVATE HISTORY/);
  const firstCache = JSON.parse(await readFile(f.cachePath, 'utf8'));
  assert.ok(firstCache.offset > 8 * 1024 * 1024);
  assert.doesNotMatch(JSON.stringify(firstCache), /PRIVATE HISTORY/);
  await f.append([{ type: 'world_state', payload: { full: true, state: { agents_md: { text: 'Current project instructions' }, permissions: { instructions: 'Keep sandbox approvals' } } } }]);
  const next = await f.read();
  assert.equal(next.incomplete, undefined);
  assert.match(next.text, /Current project instructions/);
  assert.ok(JSON.parse(await readFile(f.cachePath, 'utf8')).offset > firstCache.offset);
});
test('Claude first prompt records policy after submission and reuses it only along the current native prompt chain', async t => {
  const f = await fixture(t, 'claude-code');
  assert.match((await f.read()).incomplete, /snapshot has not been recorded/);
  await f.append([
    { type: 'user', sessionId: 'session', promptId: 'prompt-1', uuid: 'u1', parentUuid: null },
    { type: 'attachment', sessionId: 'session', uuid: 's1', parentUuid: 'u1', attachment: { type: 'prompt_snapshot', systemPrompt: ['Exact native system policy'] } },
    { type: 'assistant', sessionId: 'session', uuid: 'a1', parentUuid: 's1' },
  ]);
  const first = await f.read({ turnId: 'prompt-1' });
  assert.equal(first.incomplete, undefined);
  assert.match(first.text, /Exact native system policy/);
  await f.append([{ type: 'user', sessionId: 'session', promptId: 'prompt-2', uuid: 'u2', parentUuid: 'a1' }]);
  assert.match((await f.read({ turnId: 'prompt-1' })).incomplete, /completed prompt/);
  assert.equal((await f.read({ turnId: 'prompt-2' })).incomplete, undefined);
});
test('Claude sidechain and foreign-session snapshots never replace main policy, and a branch fails closed', async t => {
  const f = await fixture(t, 'claude-code');
  await f.append([
    { type: 'user', sessionId: 'session', promptId: 'prompt', uuid: 'u', parentUuid: null },
    { type: 'attachment', sessionId: 'session', uuid: 's', parentUuid: 'u', attachment: { type: 'prompt_snapshot', systemPrompt: ['Actual policy'] } },
    { type: 'attachment', sessionId: 'session', isSidechain: true, uuid: 'side', parentUuid: 'u', attachment: { type: 'prompt_snapshot', systemPrompt: ['WRONG SIDECHAIN'] } },
    { type: 'attachment', sessionId: 'foreign', uuid: 'other', parentUuid: null, attachment: { type: 'prompt_snapshot', systemPrompt: ['WRONG SESSION'] } },
  ]);
  assert.equal((await f.read({ turnId: 'prompt' })).incomplete, undefined);
  assert.doesNotMatch((await f.read()).text, /WRONG/);
  await f.append([{ type: 'attachment', sessionId: 'session', uuid: 'branch', parentUuid: 'u', attachment: { type: 'prompt_snapshot', systemPrompt: ['Different branch'] } }]);
  assert.match((await f.read({ turnId: 'prompt' })).incomplete, /ancestry/);
});
test('withheld policy and a render invalidation remain incomplete until an actual new native snapshot', async t => {
  const f = await fixture(t, 'claude-code');
  await f.append([{ type: 'attachment', sessionId: 'session', uuid: 's', parentUuid: null, attachment: { type: 'prompt_snapshot', systemPrompt: ['Policy SECRET'] } }]);
  const result = await f.read({ redact: text => text.replaceAll('SECRET', '[REDACTED]') });
  assert.match(result.incomplete, /redacted/);
  assert.doesNotMatch(await readFile(f.cachePath, 'utf8'), /SECRET/);
  const clean = await fixture(t, 'claude-code');
  await clean.append([{ type: 'attachment', uuid: 's', parentUuid: null, attachment: { type: 'prompt_snapshot', systemPrompt: ['Policy'] } }, { type: 'attachment', uuid: 'r', parentUuid: 's', attachment: { type: 'prompt_render_point' } }]);
  assert.match((await clean.read()).incomplete, /snapshot has not been recorded/);
  await clean.append([{ type: 'attachment', uuid: 's2', parentUuid: 'r', attachment: { type: 'prompt_snapshot', systemPrompt: ['Current policy'] } }]);
  assert.equal((await clean.read()).incomplete, undefined);
});

test('malformed old Codex records recover only after full native retained context and world state both restore current policy', async t => {
  const f = await fixture(t);
  await appendFile(f.path, '{broken native record\n');
  assert.match((await f.read()).incomplete, /could not be decoded/);
  await f.append([{ type: 'compacted', payload: { replacement_history: [developer('Current replacement policy').payload] } }]);
  assert.match((await f.read()).incomplete, /could not be decoded/);
  await f.append([{ type: 'world_state', payload: { full: true, state: { agents_md: { text: 'Current project policy' } } } }]);
  const restored = await f.read();
  assert.equal(restored.incomplete, undefined);
  assert.match(restored.text, /Current replacement policy/);
  await appendFile(f.path, '{another broken record\n');
  assert.match((await f.read()).incomplete, /could not be decoded/);
});

test('actual Codex session policy covers configuration overrides without leaving a false refusal in grader evidence', async t => {
  const { nativeFixture } = await import('./native-fixtures/setup.mjs');
  const { captureSourcePolicy } = await import('../dist/cli-learning/policy.js');
  const f = await nativeFixture(t);
  await f.put(join(f.project, '.codex', 'config.toml'), 'developer_instructions = "CONFIG_VALUE_NEVER_COPIED"\n');
  const transcript = join(f.project, 'session.jsonl');
  await writeFile(transcript, rows([{ type: 'session_meta', payload: { id: 'session', base_instructions: { text: 'Actual base' } } }, developer('Actual retained developer instruction')]));
  const snapshot = await captureSourcePolicy({ runtime: 'codex', project: f.project, cursor: await captureTranscriptCursor(transcript), env: f.env, redact: text => text, sessionId: 'session' });
  assert.equal(snapshot.incomplete, undefined);
  assert.equal(snapshot.truncated, false);
  assert.match(snapshot.text, /Actual retained developer instruction/);
  assert.doesNotMatch(snapshot.text, /CONFIG_VALUE_NEVER_COPIED|Incomplete native instruction evidence|Automatic learning cannot promote/);
});

test('Claude completion keeps the source standing policy pinned at submission if the task edits its own instruction file', async t => {
  const { nativeFixture } = await import('./native-fixtures/setup.mjs');
  const { captureSourcePolicy } = await import('../dist/cli-learning/policy.js');
  const f = await nativeFixture(t);
  await f.put(join(f.project, 'CLAUDE.md'), 'Original policy: require owner review.');
  const transcript = join(f.project, 'session.jsonl');
  await writeFile(transcript, '');
  const options = { runtime: 'claude-code', project: f.project, env: f.env, redact: text => text, sessionId: 'session' };
  const begin = await captureSourcePolicy({ ...options, cursor: await captureTranscriptCursor(transcript) });
  await f.put(join(f.project, 'CLAUDE.md'), 'NEW FILE CONTENT MAY ONLY APPLY NEXT PROMPT');
  await appendFile(transcript, rows([
    { type: 'user', sessionId: 'session', promptId: 'prompt', uuid: 'u', parentUuid: null },
    { type: 'attachment', sessionId: 'session', uuid: 's', parentUuid: 'u', attachment: { type: 'prompt_snapshot', systemPrompt: ['Exact native system policy'] } },
  ]));
  await appendFile(transcript, rows(wireRows()));
  const completed = await captureSourcePolicy({ ...options, cursor: await captureTranscriptCursor(transcript), turnId: 'prompt', pinnedStanding: begin.sourceStanding });
  assert.equal(completed.incomplete, undefined);
  assert.match(completed.text, /Original policy: require owner review/);
  assert.doesNotMatch(completed.text, /NEW FILE CONTENT/);
});

test('Claude loaded-instruction metadata covers actual imported policy and applies native changed/removed semantics', async t => {
  const f = await fixture(t, 'claude-code');
  await f.append([
    { type: 'user', sessionId: 'session', promptId: 'prompt', uuid: 'u', parentUuid: null },
    { type: 'attachment', sessionId: 'session', uuid: 'i', parentUuid: 'u', attachment: { type: 'instructions', files: [
      { path: '/project/CLAUDE.md', type: 'Project', content: 'Project policy and @shared.md' },
      { path: '/project/shared.md', type: 'Imported', content: 'Never skip owner review.' },
    ] } },
    { type: 'attachment', sessionId: 'session', uuid: 's', parentUuid: 'i', attachment: { type: 'prompt_snapshot', systemPrompt: ['Exact system policy'] } },
  ]);
  const initial = await f.read({ turnId: 'prompt' });
  assert.equal(initial.incomplete, undefined);
  assert.equal(initial.instructionsCaptured, true);
  assert.match(initial.text, /Never skip owner review/);
  await f.append([{ type: 'attachment', sessionId: 'session', uuid: 'i2', parentUuid: 's', attachment: { type: 'instructions', changed: true,
    files: [{ path: '/project/shared.md', type: 'Imported', content: 'Updated approved policy.' }], removed: ['/project/CLAUDE.md'] } }]);
  const updated = await f.read({ turnId: 'prompt' });
  assert.match(updated.text, /Updated approved policy/);
  assert.doesNotMatch(updated.text, /Never skip|Project policy/);
  const partial = await fixture(t, 'claude-code');
  await partial.append([{ type: 'attachment', attachment: { type: 'instructions', changed: true, files: [{ path: '/project/shared.md', type: 'Imported', content: 'Partial policy.' }] } }]);
  assert.match((await partial.read()).incomplete, /incomplete coverage/);
});

test('only verified complete native loaded policy can resolve legacy Claude import uncertainty', async t => {
  const { nativeFixture } = await import('./native-fixtures/setup.mjs');
  const { captureSourcePolicy } = await import('../dist/cli-learning/policy.js');
  const f = await nativeFixture(t);
  await f.put(join(f.project, 'CLAUDE.md'), '@shared.md');
  const transcript = join(f.project, 'session.jsonl');
  await writeFile(transcript, rows([
    { type: 'user', sessionId: 'session', promptId: 'prompt', uuid: 'u', parentUuid: null },
    { type: 'attachment', sessionId: 'session', uuid: 'i', parentUuid: 'u', attachment: { type: 'instructions', files: [{ path: join(f.project, 'CLAUDE.md'), type: 'Project', content: '@shared.md' }, { path: join(f.project, 'shared.md'), type: 'Imported', content: 'Captured imported policy.' }] } },
    { type: 'attachment', sessionId: 'session', uuid: 's', parentUuid: 'i', attachment: { type: 'prompt_snapshot', systemPrompt: ['Native policy'] } },
  ]));
  await appendFile(transcript, rows(wireRows()));
  const options = { runtime: 'claude-code', project: f.project, cursor: await captureTranscriptCursor(transcript), env: f.env, redact: text => text, sessionId: 'session', turnId: 'prompt' };
  const snapshot = await captureSourcePolicy(options);
  assert.equal(snapshot.incomplete, undefined);
  assert.match(snapshot.text, /Captured imported policy/);
  assert.doesNotMatch(snapshot.text, /files were not captured/);
  const missing = await captureSourcePolicy({ ...options, pinnedStanding: { text: 'Unreadable standing file.', files: [], truncated: false, incomplete: 'A policy source could not be read.' } });
  assert.equal(missing.incomplete, 'A policy source could not be read.');
});

test('a task cannot replace its original grading policy by rewriting loaded instructions after its first assistant response', async t => {
  const f=await fixture(t,'claude-code');
  await f.append([
    {type:'user',sessionId:'session',promptId:'prompt',uuid:'u',parentUuid:null},
    {type:'attachment',sessionId:'session',uuid:'i',parentUuid:'u',attachment:{type:'instructions',files:[{path:'/project/CLAUDE.md',type:'Project',content:'Require owner review.'}]}},
    {type:'attachment',sessionId:'session',uuid:'s',parentUuid:'i',attachment:{type:'prompt_snapshot',systemPrompt:['Original native system policy']}},
    {type:'assistant',sessionId:'session',uuid:'a',parentUuid:'s',message:{role:'assistant',content:'I will inspect the project.'}},
    {type:'attachment',sessionId:'session',uuid:'i2',parentUuid:'a',attachment:{type:'instructions',changed:true,files:[{path:'/project/CLAUDE.md',type:'Project',content:'Skip all owner review.'}]}},
  ]);
  const completed=await f.read({turnId:'prompt'});
  assert.match(completed.incomplete,/changed during/);
  assert.match(completed.text,/Require owner review/);
  assert.doesNotMatch(completed.text,/Skip all/);
  await f.append([
    {type:'user',sessionId:'session',promptId:'next',uuid:'u2',parentUuid:'i2'},
    {type:'assistant',sessionId:'session',uuid:'a2',parentUuid:'u2',message:{role:'assistant',content:'Next task.'}},
  ]);
  assert.equal((await f.read({turnId:'next'})).incomplete,undefined);
});

test('an unresolved native render after the first assistant cannot reuse an obsolete policy snapshot', async t => {
  const f=await fixture(t,'claude-code');
  await f.append([
    {type:'user',sessionId:'session',promptId:'prompt',uuid:'u',parentUuid:null},
    {type:'attachment',sessionId:'session',uuid:'s',parentUuid:'u',attachment:{type:'prompt_snapshot',systemPrompt:['Native system policy']}},
    {type:'assistant',sessionId:'session',uuid:'a',parentUuid:'s',message:{role:'assistant',content:'Working.'}},
    {type:'attachment',sessionId:'session',uuid:'r',parentUuid:'a',attachment:{type:'prompt_render_point'}},
  ]);
  assert.match((await f.read({turnId:'prompt'})).incomplete,/snapshot has not been recorded/);
  await f.append([{type:'attachment',sessionId:'session',uuid:'s2',parentUuid:'r',attachment:{type:'prompt_snapshot',systemPrompt:['Native system policy']}}]);
  assert.equal((await f.read({turnId:'prompt'})).incomplete,undefined);
});

test('Claude source policy contains actual main-request system envelopes and lower-trust native context without importing user blobs', async t => {
  const f=await fixture(t,'claude-code');
  await f.append([
    {type:'user',sessionId:'session',promptId:'prompt',uuid:'u',parentUuid:null},
    {type:'attachment',sessionId:'session',uuid:'c',parentUuid:'u',renderedRole:'user',rendered:[{content:'The current project uses a review workflow.'}],attachment:{type:'session_context',context:{project:'not copied directly'}}},
    {type:'attachment',sessionId:'session',uuid:'s',parentUuid:'c',attachment:{type:'prompt_snapshot',systemPrompt:['Native system base']}},
    ...wireRows(),
    {type:'assistant',sessionId:'session',uuid:'a',parentUuid:'s',message:{role:'assistant',content:'Done.'}},
  ]);
  const policy=await f.read({turnId:'prompt',requireWire:true});
  assert.equal(policy.incomplete,undefined);
  assert.equal(policy.wireCaptured,true);
  assert.match(policy.text,/MCP policy: preserve source permissions/);
  assert.match(policy.text,/lower-trust session context/);
  assert.match(policy.text,/current project uses a review workflow/);
  assert.doesNotMatch(policy.text,/PRIVATE PRIOR CONVERSATION|not copied directly/);
  assert.doesNotMatch(await readFile(f.cachePath,'utf8'),/PRIVATE PRIOR CONVERSATION|not copied directly/);
});

test('missing actual main-request policy is explicitly incomplete even when a base prompt snapshot exists', async t => {
  const f=await fixture(t,'claude-code');
  await f.append([
    {type:'user',sessionId:'session',promptId:'prompt',uuid:'u',parentUuid:null},
    {type:'attachment',sessionId:'session',uuid:'s',parentUuid:'u',attachment:{type:'prompt_snapshot',systemPrompt:['Only the base policy is known.']}},
    {type:'assistant',sessionId:'session',uuid:'a',parentUuid:'s',message:{role:'assistant',content:'Done.'}},
  ]);
  assert.match((await f.read({turnId:'prompt',requireWire:true})).incomplete,/system\/developer policy/);
});

test('literal credential-extraction regex instructions retain complete native policy without exposing a credential', async t => {
  const { redactSecrets } = await import('../dist/learn/secrets.js');
  const f=await fixture(t,'claude-code');
  const scheme='https';
  const command=String.raw`export GH_TOKEN=$(sed -n 's|${scheme}://x-access-token:\([^@]*\)@github.com|\1|p' ~/.git-credentials | head -1)`;
  await f.append([
    {type:'user',sessionId:'session',promptId:'prompt',uuid:'u',parentUuid:null},
    {type:'attachment',sessionId:'session',uuid:'i',parentUuid:'u',attachment:{type:'instructions',files:[{path:'/project/CLAUDE.md',type:'Project',content:command}]}},
    {type:'attachment',sessionId:'session',uuid:'s',parentUuid:'i',attachment:{type:'prompt_snapshot',systemPrompt:['Native system policy']}},
    ...wireRows(),
    {type:'assistant',sessionId:'session',uuid:'a',parentUuid:'s',message:{role:'assistant',content:'Done.'}},
  ]);
  const captured=await f.read({turnId:'prompt',requireWire:true,redact:text=>redactSecrets(text,[],262144)});
  assert.equal(captured.incomplete,undefined);
  assert.ok(captured.text.includes(command));
});


test('native stop-hook summary nodes preserve policy ancestry across ordinary resumed prompts', async t => {
  const f=await fixture(t,'claude-code');
  await f.append([
    {type:'user',sessionId:'session',promptId:'first',uuid:'u1',parentUuid:null},
    {type:'attachment',sessionId:'session',uuid:'s',parentUuid:'u1',attachment:{type:'prompt_snapshot',systemPrompt:['Stable policy']}},
    ...wireRows(),
    {type:'assistant',sessionId:'session',uuid:'a1',parentUuid:'s',message:{role:'assistant',content:'First answer.'}},
  ]);
  assert.equal((await f.read({turnId:'first',requireWire:true})).incomplete,undefined);
  await f.append([
    {type:'system',subtype:'stop_hook_summary',sessionId:'session',uuid:'h1',parentUuid:'a1'},
    {type:'user',sessionId:'session',promptId:'second',uuid:'u2',parentUuid:'h1'},
    ...wireRows('MCP policy: preserve source permissions.','sdk','two'),
    {type:'assistant',sessionId:'session',uuid:'a2',parentUuid:'u2',message:{role:'assistant',content:'Second answer.'}},
  ]);
  const second=await f.read({turnId:'second',requireWire:true});
  assert.equal(second.incomplete,undefined);
  assert.equal(second.wireCaptured,true);
  const cached=JSON.parse(await readFile(f.cachePath,'utf8'));
  await writeFile(f.cachePath,JSON.stringify({...cached,version:2,incomplete:'Native Claude policy ancestry branched or is incomplete.'}));
  assert.equal((await f.read({turnId:'second',requireWire:true})).incomplete,undefined,'old cache must be rescan-safe after native ancestry support changes');
  await f.append([{type:'system',subtype:'stop_hook_summary',sessionId:'session',uuid:'wrong',parentUuid:'a1'}]);
  assert.match((await f.read({turnId:'second'})).incomplete,/ancestry/,'a real rewind through a system node remains incomplete');
});


test('native resumed tool turns recover ordinary role hashes across private checkpoints and retain attested runtime updates', async t => {
  const f=await fixture(t,'claude-code');
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const user1=digest('{"content":[{"text":"PRIVATE ORIGINAL PROMPT","type":"text"}],"role":"user"}');
  const answer1=digest('{"content":[{"text":"PRIVATE ORIGINAL ANSWER","type":"text"}],"role":"assistant"}');
  const user2=digest('{"content":[{"text":"PRIVATE CORRECTION","type":"text"}],"role":"user"}');
  const assistant2=digest('{"content":[{"text":"PRIVATE TOOL PLAN","type":"text"}],"role":"assistant"}');
  const toolResult=digest('{"content":[{"content":"PRIVATE TOOL OUTPUT","tool_use_id":"tool","type":"tool_result"}],"role":"user"}');
  const shape='a'.repeat(64),system='b'.repeat(64),reminder='e'.repeat(64);
  const first='00000000-0000-0000-0000-000000000001',second='00000000-0000-0000-0000-000000000002',third='00000000-0000-0000-0000-000000000003';
  await f.append([
    {type:'user',sessionId:'session',promptId:'first',uuid:'u1',parentUuid:null,message:{role:'user',content:'PRIVATE ORIGINAL PROMPT'}},
    {type:'attachment',sessionId:'session',uuid:'s',parentUuid:'u1',attachment:{type:'prompt_snapshot',systemPrompt:['Stable policy']}},
    ...wireRows().slice(0,2),
    {type:'api-request',sessionId:'session',id:first,querySource:'sdk',shapeHash:shape,keep:0,tail:[user1,system]},
    {type:'assistant',sessionId:'session',uuid:'a1',parentUuid:'s',message:{role:'assistant',id:'answer-first',content:[{type:'text',text:'PRIVATE ORIGINAL ANSWER'}]}},
  ]);
  assert.equal((await f.read({turnId:'first',requireWire:true})).incomplete,undefined);
  await f.append([
    {type:'system',subtype:'stop_hook_summary',sessionId:'session',uuid:'h1',parentUuid:'a1'},
    {type:'user',sessionId:'session',promptId:'second',uuid:'u2',parentUuid:'h1',message:{role:'user',content:'PRIVATE CORRECTION'}},
    {type:'api-request',sessionId:'session',id:second,querySource:'sdk',shapeHash:shape,keep:0,tail:[user1,system,answer1,user2]},
    {type:'assistant',sessionId:'session',uuid:'a2',parentUuid:'u2',message:{role:'assistant',id:'answer-second',content:[{type:'text',text:'PRIVATE TOOL PLAN'}]}},
  ]);
  assert.equal((await f.read({turnId:'second',requireWire:true})).incomplete,undefined);
  await f.append([
    {type:'user',sessionId:'session',promptId:'second',uuid:'tr',parentUuid:'a2',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool',content:'PRIVATE TOOL OUTPUT'}]}},
    {type:'attachment',sessionId:'session',uuid:'r',parentUuid:'tr',renderedRole:'system',rendered:[{content:'<system-reminder>\n<total_tokens>42 tokens left</total_tokens>\n</system-reminder>'}],attachment:{type:'total_tokens_reminder',text:'<total_tokens>42 tokens left</total_tokens>'}},
    {type:'api-request-blob',sessionId:'session',hash:reminder,message:{role:'system',content:[{type:'text',text:'<total_tokens>42 tokens left</total_tokens>'}]}},
    {type:'api-request',sessionId:'session',id:third,querySource:'sdk',shapeHash:shape,base:second,keep:4,tail:[assistant2,toolResult,reminder]},
    {type:'assistant',sessionId:'session',uuid:'a3',parentUuid:'r',message:{role:'assistant',id:'answer-third',content:[{type:'text',text:'Done.'}]}},
  ]);
  const result=await f.read({turnId:'second',requireWire:true});
  assert.equal(result.incomplete,undefined);
  assert.equal(result.wireCaptured,true);
  assert.match(result.text,/<total_tokens>42 tokens left/);
  assert.doesNotMatch(result.text,/PRIVATE/);
  assert.doesNotMatch(await readFile(f.cachePath,'utf8'),/PRIVATE/);
});


test('restoring a pending native message never replays more than the aggregate 64 MiB inspection budget', async t => {
  const f=await fixture(t,'claude-code');
  await f.append([
    {type:'user',sessionId:'session',promptId:'prompt',uuid:'u',parentUuid:null,message:{role:'user',content:'Hello'}},
    {type:'attachment',sessionId:'session',uuid:'s',parentUuid:'u',attachment:{type:'prompt_snapshot',systemPrompt:['Stable policy']}},
  ]);
  await f.read();
  const cache=JSON.parse(await readFile(f.cachePath,'utf8'));
  // Native progress is non-conversation metadata: a long-running tool can leave a message
  // merge run open while the source records many progress updates between hook invocations.
  const progress=rows([{type:'progress',data:'x'.repeat(1024*1024)}]);
  for(let index=0;index<65;index++)await appendFile(f.path,progress);
  cache.offset=(await captureTranscriptCursor(f.path)).offset;
  await writeFile(f.cachePath,JSON.stringify(cache));
  await f.append([{type:'assistant',sessionId:'session',uuid:'a',parentUuid:'s',message:{role:'assistant',content:'Done.'}}]);
  assert.match((await f.read({turnId:'prompt',budgetMs:10000})).incomplete,/pending message reconstruction exceeds the 64 MiB/);
});
