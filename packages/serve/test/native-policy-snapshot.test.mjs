import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { commitWrites } from '@earendil-works/pi-durable/testing';
import { nativeSourceInstructions } from '../dist/runner/native-loop.js';
import {withSavedNativeInstructions} from '../dist/native/instructions.js';
import { queue, stores } from "./runner-support.mjs";

// The grader reads only the source run's immutable journal evidence. No native binary or model is used.
async function recordedPolicy(snapshot, { before = [], after = [], sent = true, configuration = {runtime:'codex'}, beforeConfiguration, afterConfiguration } = {}) {
  const { server } = await stores({ runners: 0 });
  const id = 'native-policy-source';
  await queue(server, id);
  const claim = await server.claim(id, 'snapshot-reviewer', { leaseMs: 60_000 });
  const journal = server.journal(claim);
  const writes = [{ type: 'conversation', value: { id: 1 } }];
  const add = async (kind, data) => writes.push({ type: 'entry', value: { id: await journal.mintId(), conversationId: 1, kind, data } });
  for (const value of before) await add('agentrun.native.instructions', value);
 if(beforeConfiguration)await add('agentrun.native.configuration',beforeConfiguration);
  if (snapshot !== undefined) await add('agentrun.native.instructions', snapshot);
 if(configuration)await add('agentrun.native.configuration',configuration);
  if (sent) await add('agentrun.native.sending', { phase: 'task' });
 if(afterConfiguration)await add('agentrun.native.configuration',afterConfiguration);
  for (const value of after) await add('agentrun.native.instructions', value);
  await commitWrites(journal, writes, BACKGROUND_CONTEXT);
  return { server, id };
}

test('native grading rejects an incomplete source policy snapshot before supplying grader context', async () => {
  const { server, id } = await recordedPolicy({ text: 'Global standing policy only; project policy was omitted.', files: [], truncated: true, codexConfigurationChecked: true });
  await assert.rejects(nativeSourceInstructions(server, id), /standing instructions exceed the grading evidence limit|incomplete|truncated/i);
});

test('native grading uses the exact immutable complete policy captured by the source run', async () => {
  const policy = 'Source policy: preserve owner approval.\nProject policy: never send release data externally.';
  const { server, id } = await recordedPolicy({ text: policy, files: [{ path: '/fixture/project/AGENTS.md', sha256: 'captured-source-hash' }], truncated: false, codexConfigurationChecked: true });
  assert.equal(await nativeSourceInstructions(server, id), policy);
});

test('native grading rejects a source run with no standing policy snapshot', async () => {
  const { server, id } = await recordedPolicy(undefined);
  await assert.rejects(nativeSourceInstructions(server, id), /lacks its immutable source instruction snapshot/i);
});

test('a reclaimed task grades the last complete policy before dispatch, not an abandoned attempt', async () => {
  const policy = { text: 'Dispatched policy: require review.', files: [], truncated: false, codexConfigurationChecked: true };
  const { server, id } = await recordedPolicy(policy, { before: [{ text: 'Abandoned policy: no review.', files: [], truncated: false, codexConfigurationChecked: true }] });
  assert.equal(await nativeSourceInstructions(server, id), policy.text);
});

test('an incomplete abandoned attempt cannot hide the complete dispatched policy', async () => {
  const { server, id } = await recordedPolicy({ text: 'Complete dispatched policy.', files: [], truncated: false, codexConfigurationChecked: true }, { before: [{ text: 'Incomplete abandoned policy.', files: [], truncated: true, codexConfigurationChecked: true }] });
  assert.equal(await nativeSourceInstructions(server, id), 'Complete dispatched policy.');
});

test('a complete abandoned policy cannot excuse incomplete dispatched evidence', async () => {
  const { server, id } = await recordedPolicy({ text: 'Truncated dispatched policy.', files: [], truncated: true, codexConfigurationChecked: true }, { before: [{ text: 'Complete abandoned policy.', files: [], truncated: false, codexConfigurationChecked: true }] });
  await assert.rejects(nativeSourceInstructions(server, id), /grading evidence limit|incomplete|truncated/i);
});

test('a snapshot after the dispatch marker cannot replace the policy actually used', async () => {
  const { server, id } = await recordedPolicy({ text: 'Actual dispatched policy.', files: [], truncated: false, codexConfigurationChecked: true }, { after: [{ text: 'Unbound later policy.', files: [], truncated: false, codexConfigurationChecked: true }] });
  assert.equal(await nativeSourceInstructions(server, id), 'Actual dispatched policy.');
});

test('policy evidence without a task dispatch marker cannot authorize learning', async () => {
  const { server, id } = await recordedPolicy({ text: 'Prepared but never dispatched.', files: [], truncated: false, codexConfigurationChecked: true }, { sent: false });
  await assert.rejects(nativeSourceInstructions(server, id), /dispatch|immutable source instruction snapshot/i);
});

test('older Codex snapshots without configuration inspection cannot authorize new learning',async()=>{
 const {server,id}=await recordedPolicy({text:'AGENTS policy only.',files:[],truncated:false},{configuration:{runtime:'codex'}});
 await assert.rejects(nativeSourceInstructions(server,id),/older Codex snapshot did not inspect custom policy configuration/);
});

test('checked ordinary Codex policy remains eligible for the immutable grader context',async()=>{
 const snapshot={text:'Complete captured policy.',files:[],truncated:false,codexConfigurationChecked:true};
 const {server,id}=await recordedPolicy(snapshot,{configuration:{runtime:'codex'}});
 assert.equal(await nativeSourceInstructions(server,id),snapshot.text);
});

test('the Codex legacy guard uses only the last configuration before task dispatch',async()=>{
 const snapshot={text:'Captured Claude policy.',files:[],truncated:false,claudeConfigurationChecked:true,claudePolicySourcesChecked:true};
 const claude=await recordedPolicy(snapshot,{beforeConfiguration:{runtime:'codex'},configuration:{runtime:'claude-code'},afterConfiguration:{runtime:'codex'}});
 assert.equal(await nativeSourceInstructions(claude.server,claude.id),snapshot.text);
 const codex=await recordedPolicy(snapshot,{beforeConfiguration:{runtime:'claude-code'},configuration:{runtime:'codex'},afterConfiguration:{runtime:'claude-code'}});
 await assert.rejects(nativeSourceInstructions(codex.server,codex.id),/older Codex snapshot/);
});

test('older Claude snapshots with a possibly wrong global main agent cannot authorize new learning',async()=>{
 const snapshot={text:'GLOBAL_AGENT_POLICY selected using directory depth.',files:[],truncated:false};
 const {server,id}=await recordedPolicy(snapshot,{configuration:{runtime:'claude-code'}});
 await assert.rejects(nativeSourceInstructions(server,id),/older Claude snapshot.*precedence/i);
});

test('checked Claude precedence evidence survives JSON and saved-instruction augmentation',async()=>{
 const snapshot=JSON.parse(JSON.stringify(withSavedNativeInstructions({text:'Project policy takes priority.',files:[],truncated:false,claudeConfigurationChecked:true,claudePolicySourcesChecked:true},'Pinned saved policy.',text=>text)));
 assert.equal(snapshot.claudeConfigurationChecked,true);assert.equal(snapshot.claudePolicySourcesChecked,true);
 const {server,id}=await recordedPolicy(snapshot,{configuration:{runtime:'claude-code'},afterConfiguration:{runtime:'codex'}});
 assert.equal(await nativeSourceInstructions(server,id),snapshot.text);
});

for(const certificate of [undefined,false])test(`old Claude import evidence cannot borrow a later certificate: ${certificate}`,async()=>{
 const snapshot={text:'@AGENTS.md',files:[],truncated:false,claudeConfigurationChecked:true,...(certificate===undefined?{}:{claudePolicySourcesChecked:certificate})};
 const complete={text:'Later complete evidence.',files:[],truncated:false,claudeConfigurationChecked:true,claudePolicySourcesChecked:true};
 const {server,id}=await recordedPolicy(snapshot,{before:[complete],after:[complete],configuration:{runtime:'claude-code'}});
 await assert.rejects(nativeSourceInstructions(server,id),/older Claude snapshot.*import/i);
});

for(const configuration of [null,{runtime:'unknown'}])test(`unknown dispatch runtime cannot bypass policy coverage: ${JSON.stringify(configuration)}`,async()=>{
 const {server,id}=await recordedPolicy({text:'@AGENTS.md',files:[],truncated:false,claudeConfigurationChecked:true},{configuration,afterConfiguration:{runtime:'claude-code'}});
 await assert.rejects(nativeSourceInstructions(server,id),/dispatch.*runtime|runtime.*dispatch/i);
});

test('a new Claude coverage marker never clears an incomplete imported policy after JSON restoration',async()=>{
 const snapshot=JSON.parse(JSON.stringify(withSavedNativeInstructions({text:'@AGENTS.md',files:[],truncated:false,claudeConfigurationChecked:true,claudePolicySourcesChecked:true,incomplete:'Claude imported policy was not captured.'},'Saved task instructions.',text=>text)));
 const {server,id}=await recordedPolicy(snapshot,{configuration:{runtime:'claude-code'}});
 await assert.rejects(nativeSourceInstructions(server,id),/Claude imported policy was not captured/);
});
