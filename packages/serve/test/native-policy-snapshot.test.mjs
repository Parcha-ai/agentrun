import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { commitWrites } from '@earendil-works/pi-durable/testing';
import { nativeSourceInstructions } from '../dist/runner/native-loop.js';
import { queue, stores } from './runner-support.mjs';

// The grader reads only the source run's immutable journal evidence. No native binary or model is used.
async function recordedPolicy(snapshot) {
  const { server } = await stores({ runners: 0 });
  const id = 'native-policy-source';
  await queue(server, id);
  const claim = await server.claim(id, 'snapshot-reviewer', { leaseMs: 60_000 });
  const journal = server.journal(claim);
  const writes = [{ type: 'conversation', value: { id: 1 } }];
  if (snapshot !== undefined) writes.push({ type: 'entry', value: { id: await journal.mintId(), conversationId: 1, kind: 'agentrun.native.instructions', data: snapshot } });
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
