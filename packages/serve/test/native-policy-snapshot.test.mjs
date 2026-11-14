import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { commitWrites } from '@earendil-works/pi-durable/testing';
import { nativeSourceInstructions } from '../dist/runner/native-loop.js';
import { queue, stores } from "./runner-support.mjs";

// The grader reads only the source run's immutable journal evidence. No native binary or model is used.
async function recordedPolicy(snapshot, { before = [], after = [], sent = true } = {}) {
  const { server } = await stores({ runners: 0 });
  const id = 'native-policy-source';
  await queue(server, id);
  const claim = await server.claim(id, 'snapshot-reviewer', { leaseMs: 60_000 });
  const journal = server.journal(claim);
  const writes = [{ type: 'conversation', value: { id: 1 } }];
  const add = async (kind, data) => writes.push({ type: 'entry', value: { id: await journal.mintId(), conversationId: 1, kind, data } });
  for (const value of before) await add('agentrun.native.instructions', value);
  if (snapshot !== undefined) await add('agentrun.native.instructions', snapshot);
  if (sent) await add('agentrun.native.sending', { phase: 'task' });
  for (const value of after) await add('agentrun.native.instructions', value);
  await commitWrites(journal, writes, BACKGROUND_CONTEXT);
  return { server, id };
}

test('native grading rejects an incomplete source policy snapshot before supplying grader context', async () => {
  const { server, id } = await recordedPolicy({ text: 'Global standing policy only; project policy was omitted.', files: [], truncated: true });
  await assert.rejects(nativeSourceInstructions(server, id), /standing instructions exceed the grading evidence limit|incomplete|truncated/i);
});

test('native grading uses the exact immutable complete policy captured by the source run', async () => {
  const policy = 'Source policy: preserve owner approval.\nProject policy: never send release data externally.';
  const { server, id } = await recordedPolicy({ text: policy, files: [{ path: '/fixture/project/AGENTS.md', sha256: 'captured-source-hash' }], truncated: false });
  assert.equal(await nativeSourceInstructions(server, id), policy);
});

test('native grading rejects a source run with no standing policy snapshot', async () => {
  const { server, id } = await recordedPolicy(undefined);
  await assert.rejects(nativeSourceInstructions(server, id), /lacks its immutable source instruction snapshot/i);
});

test('a reclaimed task grades the last complete policy before dispatch, not an abandoned attempt', async () => {
  const policy = { text: 'Dispatched policy: require review.', files: [], truncated: false };
  const { server, id } = await recordedPolicy(policy, { before: [{ text: 'Abandoned policy: no review.', files: [], truncated: false }] });
  assert.equal(await nativeSourceInstructions(server, id), policy.text);
});

test('an incomplete abandoned attempt cannot hide the complete dispatched policy', async () => {
  const { server, id } = await recordedPolicy({ text: 'Complete dispatched policy.', files: [], truncated: false }, { before: [{ text: 'Incomplete abandoned policy.', files: [], truncated: true }] });
  assert.equal(await nativeSourceInstructions(server, id), 'Complete dispatched policy.');
});

test('a complete abandoned policy cannot excuse incomplete dispatched evidence', async () => {
  const { server, id } = await recordedPolicy({ text: 'Truncated dispatched policy.', files: [], truncated: true }, { before: [{ text: 'Complete abandoned policy.', files: [], truncated: false }] });
  await assert.rejects(nativeSourceInstructions(server, id), /grading evidence limit|incomplete|truncated/i);
});

test('a snapshot after the dispatch marker cannot replace the policy actually used', async () => {
  const { server, id } = await recordedPolicy({ text: 'Actual dispatched policy.', files: [], truncated: false }, { after: [{ text: 'Unbound later policy.', files: [], truncated: false }] });
  assert.equal(await nativeSourceInstructions(server, id), 'Actual dispatched policy.');
});

test('policy evidence without a task dispatch marker cannot authorize learning', async () => {
  const { server, id } = await recordedPolicy({ text: 'Prepared but never dispatched.', files: [], truncated: false }, { sent: false });
  await assert.rejects(nativeSourceInstructions(server, id), /dispatch|immutable source instruction snapshot/i);
});
