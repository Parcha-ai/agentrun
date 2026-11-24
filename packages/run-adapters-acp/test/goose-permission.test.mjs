// Goose asks no permission for a call of our tools: at each start the adapter writes the recipe's allowFile (Goose's:
// `.config/goose/permission.yaml`, form `goose-permission`) into the run's private HOME, every tool that start lists
// allowed by the name Goose calls it (`agentrun__<tool>`) and nothing else, which Goose 1.59.2's approve mode reads before
// it would ask. The host's gate is asked once per call, at the MCP call, under the agent's own id. Run on the fake agent
// (testing/fake-acp-agent.mjs) as Goose's binary, which reads that file as Goose does; no Goose, no model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gooseAdapter } from '@parcha/agentrun-harness-acp';
import { FAKE, fakeEvents, fakeRecipe, GOOSE_ALLOW_FILE, openSession, scratch, tool } from './helpers.mjs';

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

test("the recipe's allowFile is written from that start's tools alone; a recipe without one writes none, and the agent's request for our tool goes to the host's gate", { timeout: 60_000 }, async (t) => {
  const script = [{ call: 'write', args: { path: 'a.txt', content: 'x' } }, { sayLastResult: true }];
  const withFile = fakeRecipe(scratch(), { script, style: 'goose', askMcp: true }, { allowFile: GOOSE_ALLOW_FILE });
  const asked = [];
  const one = await openSession(t, withFile, { tools: [tool('write', () => 'wrote')], gate: async (call) => (asked.push(call), 'allow') });
  await one.session.send('go');
  assert.equal((await one.session.turnEnd()).status, 'completed');
  const home = fakeEvents(withFile).find((e) => e.type === 'start')?.home;
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.config', 'goose', 'permission.yaml'), 'utf8')).user.always_allow, ['agentrun__write'], "this start's tools, by Goose's names");
  assert.deepEqual(asked.map((c) => c.tool), ['write']);

  const without = fakeRecipe(scratch(), { script, style: 'goose', askMcp: true }, { allowFile: undefined });
  const refused = [];
  const two = await openSession(t, without, { tools: [tool('write', () => 'wrote')], gate: async (call) => (refused.push(call), call.tool.startsWith('acp_') ? { deny: 'no' } : 'allow') });
  await two.session.send('go');
  assert.equal((await two.session.turnEnd()).status, 'completed');
  const bare = fakeEvents(without).find((e) => e.type === 'start')?.home;
  assert.equal(existsSync(join(bare, '.config', 'goose', 'permission.yaml')), false, 'no allowFile, no file');
  assert.deepEqual(refused.map((c) => c.tool), ['acp_other'], "Goose's request for our tool, with no file, is the host gate's");
});
