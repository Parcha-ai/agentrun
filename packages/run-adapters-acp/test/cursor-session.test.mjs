// What Cursor's recipe asks of the adapter, on the fake agent in Cursor's measured shapes (harness S0, Cursor
// 2026.11.13): its key handed by name and no other, the credential it derives from it never written (it runs on the key
// in its env, as the real binary does when it cannot save one), the run's
// model chosen among those its key lists, an MCP call named only after it is announced, and its own refusals by name.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { ACP_CODES, recipeFile, STATE_STREAM, TOOLS_STREAM } from '@parcha/agentrun-harness-acp';
import { fakeEvents, fakeRecipe, openSession, scratch, streamRecords, tool, toolEffects } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const KEY = 'fake-test-key';
const sha = (text) => createHash('sha256').update(text).digest('hex');
/** The private HOME the adapter made for session `s1` under `sessionsDir`. */
const homeOf = (sessionsDir) => join(sessionsDir, sha('s1').slice(0, 32), 'home');
const cursorLike = (dir, fake, recipe = {}) => fakeRecipe(dir, { style: 'cursor', announce: 'late', writeAuth: true, ...fake }, { keys: ['CURSOR_API_KEY'], credentials: ['.config/cursor/auth.json'], state: ['.fake-acp'], ...recipe });

test("the recipe's key reaches the agent by name, and no other key of the host's does", async (t) => {
  const dir = scratch();
  const recipe = cursorLike(dir, { script: [{ say: 'hi' }] });
  const env = { PATH: process.env.PATH, CURSOR_API_KEY: KEY, OPENAI_API_KEY: 'fake-test-key', ANTHROPIC_API_KEY: 'fake-test-key' };
  const { session } = await openSession(t, recipe, { options: { env } });
  await session.send('go');
  assert.equal((await session.turnEnd()).status, 'completed');
  const start = fakeEvents(recipe).find((e) => e.type === 'start');
  assert.ok(start.env.includes('CURSOR_API_KEY'));
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(start.env.includes(name), false, name);
  assert.equal(fakeEvents(recipe).find((e) => e.type === 'auth').keySha, sha(KEY), 'the value handed is the host\'s');
});

test('a recipe whose key the host does not hold refuses the start, naming the key', async (t) => {
  const recipe = cursorLike(scratch(), { script: [{ say: 'never' }] });
  const { session } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH } } });
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, new RegExp(`^${ACP_CODES.keyMissing}: `), end.error);
  assert.match(end.error, /CURSOR_API_KEY/);
  assert.equal(fakeEvents(recipe).some((e) => e.type === 'start'), false, 'the agent never started');
});

/** Every file under `dir` (its path), walked whole. */
const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : []);
/** The files under `dir` that hold the credential the fake derives from KEY. */
const holdingCredential = (dir) => filesIn(dir).filter((file) => readFileSync(file, 'utf8').includes(sha(KEY)));

test('the credential the agent derives from its key is never written: it runs on the key in its env alone', async (t) => {
  const dir = scratch();
  const sessionsDir = join(dir, 'sessions');
  const recipe = cursorLike(dir, { script: [{ say: 'one' }, { say: 'two' }] });
  const { session, store } = await openSession(t, recipe, { sessionsDir, options: { env: { PATH: process.env.PATH, CURSOR_API_KEY: KEY } } });
  await session.send('a');
  assert.equal((await session.turnEnd()).status, 'completed', 'the agent goes on with the credential it holds in memory');
  const auths = fakeEvents(recipe).filter((e) => e.type === 'auth');
  assert.ok(auths.length > 0, 'the agent tried to save it');
  assert.deepEqual(auths.map((e) => e.saved), auths.map(() => false), 'and could not, at any session/new or session/load');
  assert.deepEqual(holdingCredential(homeOf(sessionsDir)), [], 'no file in its HOME holds it while it runs');
  await session.close();
  assert.equal(existsSync(homeOf(sessionsDir)), false, 'the private HOME is gone whole after the session');
  const mirrored = (await streamRecords(store, STATE_STREAM)).map((r) => r.path);
  assert.ok(mirrored.length > 0, 'the session store was mirrored');
  assert.equal(mirrored.some((path) => path.includes('auth')), false, mirrored.join(', '));
});

test('a hard kill leaves no credential on disk: the agent never wrote one, so there is nothing for a sweep to find', async (t) => {
  const dir = scratch();
  const sessionsDir = join(dir, 'sessions');
  const recipe = cursorLike(dir, { script: [{ say: 'one' }, { say: 'two' }] });
  const { session } = await openSession(t, recipe, { sessionsDir, options: { env: { PATH: process.env.PATH, CURSOR_API_KEY: KEY } } });
  await session.send('a');
  assert.equal((await session.turnEnd()).status, 'completed');
  const { pid } = fakeEvents(recipe).find((e) => e.type === 'start');
  // SIGKILL, as a run's host dying takes its agent: no dispose runs, no HOME is removed.
  process.kill(pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(holdingCredential(sessionsDir), [], 'no file anywhere under the session folder holds it');
  assert.equal(filesIn(join(homeOf(sessionsDir), '.config/cursor/auth.json')).length, 0, 'auth.json is no file, and holds none');
});

test("an agent killed mid-turn is said ACP_AGENT_EXITED in plain words: Cursor's warning that it could not save its credential is not why", async (t) => {
  const dir = scratch();
  const recipe = cursorLike(dir, { script: [{ die: true }] }, { quiet: recipeFile('cursor').quiet });
  const { session } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH, CURSOR_API_KEY: KEY } } });
  await session.send('a');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, new RegExp(`^${ACP_CODES.agentExited}: `), end.error);
  assert.doesNotMatch(end.error, /couldn't save|EISDIR|auth\.json/, end.error);
  assert.doesNotMatch(end.error, /\u001b/, 'no terminal escape');
});

test('a credential the recipe names is never written nor mirrored, even inside a state path and under a name no filter knows', async (t) => {
  const dir = scratch();
  const sessionsDir = join(dir, 'sessions');
  // A custom recipe whose state path holds its credential: `.agent/login.json` says nothing of a credential by its name.
  const recipe = cursorLike(dir, { script: [{ say: 'one' }], authFile: '.agent/login.json' }, { credentials: ['.agent/login.json'], state: ['.fake-acp', '.agent'] });
  const { session, store } = await openSession(t, recipe, { sessionsDir, options: { env: { PATH: process.env.PATH, CURSOR_API_KEY: KEY } } });
  await session.send('a');
  assert.equal((await session.turnEnd()).status, 'completed');
  assert.deepEqual(holdingCredential(homeOf(sessionsDir)), [], 'the agent could not write it');
  await session.close();
  const mirrored = (await streamRecords(store, STATE_STREAM)).map((r) => r.path);
  assert.ok(mirrored.length > 0, 'the session store was mirrored');
  assert.equal(mirrored.some((path) => path.startsWith('.agent/login.json')), false, mirrored.join(', '));
  assert.equal(existsSync(homeOf(sessionsDir)), false, 'the private HOME is gone whole');
});

test('another runner loads the session after the wipe: its store came back from the records', async (t) => {
  const store = memorySessionStore();
  const dir = scratch();
  const recipe = cursorLike(dir, { script: [{ say: 'one' }, { say: 'two' }] });
  const env = { PATH: process.env.PATH, CURSOR_API_KEY: KEY };
  const first = await openSession(t, recipe, { store, sessionsDir: join(dir, 'a'), options: { env } });
  await first.session.send('a');
  await first.session.turnEnd();
  await first.session.close();
  const second = await openSession(t, recipe, { store, sessionsDir: join(dir, 'b'), options: { env } });
  await second.session.send('b');
  assert.equal((await second.session.turnEnd()).status, 'completed');
  assert.ok(fakeEvents(recipe).some((e) => e.type === 'load'), 'session/load, not a new session');
});

test("the shipped recipe's config and session store are where Cursor reads them under the adapter's XDG_CONFIG_HOME: its Write deny holds, and another runner loads the session", async (t) => {
  // Cursor 2026.11.13 keeps both in $XDG_CONFIG_HOME/cursor when that is set (the adapter sets it), never ~/.cursor:
  // a config written to ~/.cursor is never read, so its deny is not either, and a store mirrored from there is empty.
  const shipped = recipeFile('cursor');
  const store = memorySessionStore();
  const dir = scratch();
  const nativeLog = join(dir, 'native.log');
  const recipe = cursorLike(dir, { cursorDirs: true, nativeLog, script: [{ native: 'edit', title: 'Edit proof.txt' }, { say: 'one' }, { say: 'two' }] }, { files: shipped.files, state: shipped.state });
  const env = { PATH: process.env.PATH, CURSOR_API_KEY: KEY };
  const first = await openSession(t, recipe, { store, sessionsDir: join(dir, 'a'), options: { env } });
  await first.session.send('a');
  assert.equal((await first.session.turnEnd()).status, 'completed');
  const start = fakeEvents(recipe).find((e) => e.type === 'start');
  assert.equal(start.deniesWrite, true, `Cursor reads its config in ${start.cursorDir}, and the deny is there`);
  assert.equal(existsSync(nativeLog) ? readFileSync(nativeLog, 'utf8') : '', '', 'the edit never ran');
  await first.session.close();
  const second = await openSession(t, recipe, { store, sessionsDir: join(dir, 'b'), options: { env } });
  await second.session.send('b');
  assert.equal((await second.session.turnEnd()).status, 'completed');
  assert.ok(fakeEvents(recipe).some((e) => e.type === 'load'), 'session/load found the store the records gave back');
});

const MODELS = [
  { modelId: 'auto-smart[optimize_for=balanced]', name: 'Auto Balance' },
  { modelId: 'gpt-5.4-nano[reasoning=medium]', name: 'gpt-5.4-nano' },
  { modelId: 'composer-2.5', name: 'composer-2.5' },
];

test("the run's model is chosen among those the agent lists, by its id or its name before the brackets", async (t) => {
  for (const [given, chosen] of [['gpt-5.4-nano', 'gpt-5.4-nano[reasoning=medium]'], ['composer-2.5', 'composer-2.5'], ['gpt-5.4-nano[reasoning=medium]', 'gpt-5.4-nano[reasoning=medium]']]) {
    const recipe = cursorLike(scratch(), { script: [{ say: 'hi' }], models: MODELS }, { model: given });
    const { session } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH, CURSOR_API_KEY: KEY } } });
    await session.send('go');
    assert.equal((await session.turnEnd()).status, 'completed', given);
    const events = fakeEvents(recipe);
    assert.deepEqual(events.filter((e) => e.type === 'set_model').map((e) => e.modelId), [chosen], given);
    assert.ok(events.findIndex((e) => e.type === 'set_model') < events.findIndex((e) => e.type === 'prompt'), 'chosen before the first prompt');
    await session.close();
  }
});

test('no model given: the agent keeps its own default, and none is chosen', async (t) => {
  const recipe = cursorLike(scratch(), { script: [{ say: 'hi' }], models: MODELS });
  const { session } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH, CURSOR_API_KEY: KEY } } });
  await session.send('go');
  assert.equal((await session.turnEnd()).status, 'completed');
  assert.equal(fakeEvents(recipe).some((e) => e.type === 'set_model'), false);
});

test('a model the agent does not list refuses the turn by name, saying those it lists, and sends no prompt', async (t) => {
  const recipe = cursorLike(scratch(), { script: [{ say: 'never' }], models: MODELS }, { model: 'gpt-9' });
  const { session } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH, CURSOR_API_KEY: KEY } } });
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, new RegExp(`^${ACP_CODES.modelUnlisted}: `), end.error);
  assert.match(end.error, /gpt-9/);
  assert.match(end.error, /gpt-5\.4-nano/);
  assert.match(end.error, /composer-2\.5/);
  assert.equal(fakeEvents(recipe).some((e) => e.type === 'prompt'), false);
});

test("an MCP call Cursor names only after announcing it runs once, under the agent's id, gated once as our tool", async (t) => {
  const recipe = cursorLike(scratch(), { script: [{ call: 'read', args: { path: 'a' } }, { sayLastResult: true }] });
  const asked = [];
  let ran = 0;
  const { session, store, events } = await openSession(t, recipe, {
    tools: [tool('read', () => ((ran += 1), 'contents'), 'safe')],
    gate: async (call) => (asked.push(call.tool), 'allow'),
    options: { env: { PATH: process.env.PATH, CURSOR_API_KEY: KEY } },
  });
  await session.send('go');
  assert.equal((await session.turnEnd()).status, 'completed');
  assert.equal(ran, 1);
  assert.deepEqual(asked, ['read'], "the host's gate was asked once, for our tool, never as one of the agent's own");
  assert.deepEqual(fakeEvents(recipe).filter((e) => e.type === 'permission').map((e) => e.kind), ['allow_once']);
  const effects = await toolEffects(store, 'read');
  assert.equal(effects.length, 1);
  assert.equal(effects[0].key, 'tool:call_0', "the call's id is the agent's own");
  assert.equal((await streamRecords(store, TOOLS_STREAM)).length, 1, 'counted once against the plan limit');
  assert.ok(events.some((e) => e.type === 'text' && e.delta === 'contents'));
});

test("Cursor's own refusal (the team admin turned headless use off) is said by its code, in the recipe's words", async (t) => {
  const recipe = cursorLike(scratch(), { script: [{ say: 'never' }], failNew: 'Error: Your team administrator has disabled headless Cursor CLI usage.' }, {
    refusals: [{ says: 'disabled headless Cursor CLI usage', code: 'CURSOR_HEADLESS_DISABLED', words: "your Cursor team administrator turned headless Cursor CLI use off; AgentRun does not run Cursor for this team" }],
  });
  const { session } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH, CURSOR_API_KEY: KEY } } });
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, /^CURSOR_HEADLESS_DISABLED: your Cursor team administrator turned headless Cursor CLI use off/, end.error);
});

test('a HOME holding no named credential is kept as it was (Goose): only a recipe that names one is wiped', async (t) => {
  const dir = scratch();
  const sessionsDir = join(dir, 'sessions');
  const recipe = fakeRecipe(dir, { script: [{ say: 'one' }] });
  const { session } = await openSession(t, recipe, { sessionsDir });
  await session.send('a');
  await session.turnEnd();
  await session.close();
  assert.ok(readdirSync(homeOf(sessionsDir)).length > 0);
});
