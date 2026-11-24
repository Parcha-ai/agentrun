// Goose asks no permission for a call of our tools: at each start its adapter writes Goose's permission file into the
// run's private HOME (`.config/goose/permission.yaml`), every tool the run lists allowed by the name Goose calls it
// (`agentrun__<tool>`) and nothing else, which Goose 1.59.2's approve mode reads before it would ask. The host's gate is
// asked once per call, at the MCP call, under the agent's own id. Run on the fake agent (testing/fake-acp-agent.mjs) as
// Goose's binary, which reads that file as Goose does; no Goose, no model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gooseAdapter } from '@parcha/agentrun-harness-acp';
import { FAKE, fakeEvents, fakeRecipe, openSession, scratch, tool } from './helpers.mjs';

/** The fake agent behind a launcher at Goose's binary's place (Goose's own `acp` argument ignored), and the adapter
 *  gooseAdapter makes of it, pinned to the launcher's sha256. */
function fakeGoose(fake) {
  const dir = scratch();
  const recipe = fakeRecipe(dir, fake);
  const binary = join(dir, 'goose');
  writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' '${recipe.args[1]}'\n`);
  chmodSync(binary, 0o755);
  const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  const adapter = gooseAdapter({ binary, sha256, model: 'claude-sonnet-5-5', provider: { origin: 'http://127.0.0.1:9', credential: () => 'fake-test-key' }, price: () => 0, sessionsDir: join(dir, 'sessions'), env: { PATH: process.env.PATH } });
  return { recipe, adapter };
}

test("Goose's permission file holds the run's tools as always allowed, by Goose's names, and nothing else; Goose asks nothing for our call and the gate is asked once, at the MCP call", { timeout: 60_000 }, async (t) => {
  const { recipe, adapter } = fakeGoose({ script: [{ call: 'write', args: { path: 'proof.txt', content: 'hello' } }, { sayLastResult: true }], style: 'goose-1.59', titleSummary: 'proof.txt', askMcp: true });
  const wrote = [];
  const asked = [];
  const { session } = await openSession(t, recipe, {
    adapter,
    tools: [tool('write', (args) => (wrote.push(args), 'wrote proof.txt')), tool('look_up', () => 'found')],
    gate: async (call) => (asked.push(call), 'allow'),
  });
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'completed', end.error);
  const home = fakeEvents(recipe).find((e) => e.type === 'start')?.home;
  const file = join(home, '.config', 'goose', 'permission.yaml');
  // Before: no such file, so Goose asked permission for every call of ours.
  assert.ok(existsSync(file), `written into the private HOME: ${file}`);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { user: { always_allow: ['agentrun__write', 'agentrun__look_up'], ask_before: [], never_allow: [] } });
  assert.deepEqual(fakeEvents(recipe).filter((e) => e.type === 'permission'), [], 'Goose asked no permission');
  assert.deepEqual(asked.map((c) => [c.tool, c.callId]), [['write', 'call_0']], "the gate is asked once, by the bridge, under the agent's id");
  assert.deepEqual(wrote, [{ path: 'proof.txt', content: 'hello' }]);
});
