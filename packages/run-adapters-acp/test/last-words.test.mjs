// An agent that dies mid-turn saying why on stderr: its connection can close (its stdout's end) before its stderr is read
// to the end, as a dying process's pipes are read in either order. The turn's failure reads its stderr once its process
// has closed, so the refusal it names is the failure, never ACP_AGENT_EXITED for want of the words still in the pipe.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACP_CODES } from '@parcha/agentrun-harness-acp';
import { fakeRecipe, openSession, scratch } from './helpers.mjs';

const REFUSAL = { says: 'the vendor refused the key', code: 'FAKE_VENDOR_REFUSED', words: "the agent's vendor refused its key" };

test("a turn whose agent closes its stdout, then says a refusal the recipe names on stderr and exits, fails as that refusal, never as the agent's exit", { timeout: 60_000 }, async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ lastWords: `${REFUSAL.says} (401)`, afterMs: 1_000 }] }, { refusals: [REFUSAL] });
  const { session } = await openSession(t, recipe);
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.equal(end.error, `${REFUSAL.code}: ${REFUSAL.words}`, `the refusal it named, read after its stderr's end: ${end.error}`);
  assert.doesNotMatch(end.error, new RegExp(`^${ACP_CODES.agentExited}`));
});
