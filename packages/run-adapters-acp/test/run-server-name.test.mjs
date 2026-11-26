// One name for our MCP server per run, across its starts. Under a recipe that names it per start (`ar` and 6 hex: the
// title tie, agy's), the first start's name is kept with the run and given again at each later start, so an agent that
// keeps the name it was first given with its session (Cursor 2026.11.13 does: after a restart it titled
// `ar7e621c-web_fetch` though that start named the server `arc50d18`) still names our calls under ours. A config the
// agent reads that declares a server under the kept name has that name refused at the start: a fresh one is used, the
// run is told once which file declared it, and a call titled under the old name is another server's, asked at the gate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { recipeFile, recipeProblems } from '@parcha/agentrun-harness-acp';
import { fakeEvents, fakeRecipe, openSession, scratch, tool } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const sha = (text) => createHash('sha256').update(text).digest('hex');
/** The private HOME the adapter makes for session `s1` under `sessionsDir`. */
const homeOf = (sessionsDir) => join(sessionsDir, sha('s1').slice(0, 32), 'home');
const texts = (events) => events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
const notices = (events) => events.filter((e) => e.type === 'notice').map((e) => e.text);
const START = /^ar[0-9a-f]{6}$/;
/** The names the agent was given for our server at each session/new and session/load, in order. */
const given = (recipe) => fakeEvents(recipe).filter((e) => e.type === 'new' || e.type === 'load').map((e) => e.names?.[0]);
const write = (file, text) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, text));
const declaring = (name) => JSON.stringify({ mcpServers: { [name]: { url: 'http://127.0.0.1:9/mcp' } } });

/** Cursor's shapes on the fake: the title tie, the late-named call, and the name kept with the session. */
const cursorLike = (dir, script, recipe = {}) => fakeRecipe(dir, { style: 'cursor', announce: 'late', keepsName: true, script }, recipe);

/** Two starts of one run, on one store, each in a runner of its own (its own sessions folder): turn `a` on the
 *  first, `b` on the second. `between(kept)` runs after the first closes; `look_up` runs `during(kept)` too. */
async function twoStarts(t, recipe, { cwd, between = () => {}, during = () => {} } = {}) {
  const store = memorySessionStore();
  const dir = scratch();
  const asked = [[], []];
  let start = 0;
  const kept = () => given(recipe)[0];
  const open = (sessionsDir) => openSession(t, recipe, {
    store,
    sessionsDir,
    cwd,
    tools: [tool('look_up', () => (during(kept(), sessionsDir), 'found it'))],
    gate: async (call) => (asked[start].push(call), call.tool.startsWith('acp_') ? { deny: 'not ours' } : 'allow'),
  });
  const first = await open(join(dir, 'a'));
  await first.session.send('a');
  assert.equal((await first.session.turnEnd()).status, 'completed');
  await first.session.close();
  between(kept());
  start = 1;
  const second = await open(join(dir, 'b'));
  await second.session.send('b');
  assert.equal((await second.session.turnEnd()).status, 'completed');
  return { kept: kept(), first, second, asked };
}

test("a session loaded by a later start is given the run's own name again: Cursor titles our call under it, and the call runs tied, with no ask at the gate", async (t) => {
  const recipe = cursorLike(scratch(), [{ say: 'one' }, { call: 'look_up', args: { q: 'x' } }, { sayLastResult: true }]);
  const { kept, second, asked } = await twoStarts(t, recipe);
  assert.deepEqual(asked[1].map((c) => [c.tool, c.args.server ?? c.callId]), [['look_up', 'call_1']], "the gate is asked once, by the bridge, about our tool's call");
  assert.match(kept, START);
  assert.deepEqual(given(recipe), [kept, kept], 'the load is given the name the run was first given');
  assert.equal(texts(second.events), 'found it');
  assert.deepEqual(notices(second.events), []);
  assert.ok(fakeEvents(recipe).some((e) => e.type === 'mcp' && e.toolCallId === 'call_1'), 'the call reached our server');
});

for (const [where, path, file] of [
  ['the work directory', '.cursor/mcp.json', (cwd) => join(cwd, '.cursor/mcp.json')],
  ['HOME (a state path)', '~/.fake-acp/mcp.json', (_cwd, sessionsDir) => join(homeOf(sessionsDir), '.fake-acp/mcp.json')],
]) {
  test(`a config in ${where} that declares a server under the run's name has it refused at the next start: a fresh name, said once, and a call titled under the old one asks the gate naming that server`, async (t) => {
    const cwd = scratch();
    // The agent writes it in its turn (our tool stands in for its own edit), aiming at the name its titles show.
    const recipe = cursorLike(scratch(), [{ call: 'look_up', args: { q: 'x' } }, { say: 'one' }, { call: 'look_up', args: { q: 'y' } }, { sayLastResult: true }], { mcpConfigs: [path] });
    const { kept, second, asked } = await twoStarts(t, recipe, { cwd, during: (name, sessionsDir) => write(file(cwd, sessionsDir), declaring(name)) });
    assert.match(kept, START);
    const [, fresh] = given(recipe);
    assert.match(fresh ?? '', START);
    assert.notEqual(fresh, kept, 'the kept name is refused for this start');
    const said = notices(second.events);
    assert.equal(said.length, 1, `said once: ${JSON.stringify(said)}`);
    assert.match(said[0], new RegExp(kept));
    assert.match(said[0], /mcp\.json/);
    assert.deepEqual(asked[1].map((c) => [c.tool, c.args.title, c.args.server]), [['acp_other', `${kept}-look_up: look_up`, kept]], 'a call under the old name is another server\'s');
    assert.equal(texts(second.events), 'the client refused the call');
  });
}

test("a config that does not parse is no refusal: the run keeps its name, and nothing is said", async (t) => {
  const cwd = scratch();
  const recipe = cursorLike(scratch(), [{ say: 'one' }, { call: 'look_up', args: { q: 'x' } }, { sayLastResult: true }], { mcpConfigs: ['.cursor/mcp.json'] });
  const { kept, second, asked } = await twoStarts(t, recipe, { cwd, between: () => write(join(cwd, '.cursor/mcp.json'), '{"mcpServers": {') });
  assert.deepEqual(given(recipe), [kept, kept]);
  assert.deepEqual(notices(second.events), []);
  assert.deepEqual(asked[1].map((c) => c.tool), ['look_up']);
});

test("a recipe on the fixed name keeps it: Goose's agent is given `agentrun` at every start", async (t) => {
  const recipe = fakeRecipe(scratch(), { style: 'goose-1.59', script: [{ say: 'one' }, { call: 'look_up', args: { q: 'x' } }, { sayLastResult: true }] });
  const { second } = await twoStarts(t, recipe);
  assert.deepEqual(given(recipe), ['agentrun', 'agentrun']);
  assert.equal(texts(second.events), 'found it');
});

test("recipeProblems refuses an MCP config path that leaves HOME or the work directory, or is no path", () => {
  const base = { ...recipeFile('cursor'), command: '/opt/agents/cursor/cursor-agent' };
  assert.deepEqual(recipeProblems(base), []);
  for (const bad of [['/etc/mcp.json'], ['../mcp.json'], ['~/../mcp.json'], [''], [7], 'x']) assert.match(recipeProblems({ ...base, mcpConfigs: bad }).join(' '), /mcpConfigs/, JSON.stringify(bad));
  assert.deepEqual(recipeProblems({ ...base, mcpConfigs: ['~/.cursor/mcp.json', '.cursor/mcp.json'] }), []);
});

test("Cursor's recipe lists the MCP configs Cursor 2026.11.13 reads: ~/.cursor/mcp.json and the work directory's .cursor/mcp.json", () => {
  assert.deepEqual(recipeFile('cursor').mcpConfigs, ['~/.cursor/mcp.json', '.cursor/mcp.json']);
});
