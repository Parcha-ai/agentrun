// How an agent signs in (recipe.authMethod, recipe.keyEnv, recipe.stderr), as Google Antigravity does: ACP `authenticate`
// with a method its initialize lists, before any session opens. Two routes:
//  - a key saved for this harness alone, handed under the name the agent reads (a server's own key under that name never
//    reaches it), its method `gemini-api-key`;
//  - on an attended run, a person's own sign-in (`oauth-personal`), which the agent reads from a folder of its own the
//    recipe's env names. The adapter never reads, copies or mirrors it, and keeps no word the agent prints or answers
//    (recipe.stderr "none"): a failure says the agent's exit status and the adapter's codes alone.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { ACP_CODES, recipeProblems, STATE_STREAM } from '@parcha/agentrun-harness-acp';
import { fakeEvents, fakeRecipe, openSession, scratch, streamRecords } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const sha = (text) => createHash('sha256').update(text).digest('hex');
/** Fake literals shaped as a token and two keys, never real ones: no record, event or log line may hold any of them. */
const TOKEN = 'fake-signin-token-Qz7Wv9Lm2Np4Rs6Tx8Yb3Kc5Hd';
const KEY = 'fake-harness-key-Hb4Tn8Wq2Lx6Rz9Pc3Vm7Kd5Js';
const SERVER_KEY = 'fake-server-key-Mw3Xk7Qp9Zt2Lr6Nb8Vc4Hf5Dg';
const LOGIN = 'fake-login';
const API_KEY = 'fake-api-key';
/** The fake: it lists both methods, reads its login from $FAKE_LOGIN_HOME/token.json and its key from FAKE_VENDOR_KEY. */
const AUTH = { methods: [LOGIN, API_KEY], home: { method: LOGIN, env: 'FAKE_LOGIN_HOME', file: 'token.json' }, key: { method: API_KEY, env: 'FAKE_VENDOR_KEY' } };

/** The folder the person's own login left (or not: `made` false), as the agent itself writes it. */
function loginFolder(dir, made = true) {
  const folder = join(dir, 'sign-in');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (made) writeFileSync(join(folder, 'token.json'), `${TOKEN}\n`, { mode: 0o600 });
  return folder;
}

/** An attended run on the person's sign-in: the agent pointed at its folder, nothing it says kept. */
const attended = (dir, folder, { leak, method = LOGIN, stderr = 'none' } = {}) =>
  fakeRecipe(dir, { script: [{ say: 'one' }], auth: { ...AUTH, ...(leak ? { leak } : {}) } }, { env: { FAKE_LOGIN_HOME: folder }, authMethod: method, stderr });

/** Everything a run left that a person or a host reads: its records, its events, its log lines. */
async function leftBehind(store, events, lines) {
  return JSON.stringify([await store.read('s1'), events, lines]);
}

test("the key route: a key saved under the harness's own name reaches the agent under the name it reads, the server's own value under that name never does", async (t) => {
  const dir = scratch();
  const recipe = fakeRecipe(dir, { script: [{ say: 'one' }], auth: AUTH }, { keys: ['FAKE_SAVED_KEY'], keyEnv: { FAKE_SAVED_KEY: 'FAKE_VENDOR_KEY' }, authMethod: API_KEY });
  const lines = [];
  const { session, store, events } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH, FAKE_SAVED_KEY: KEY, FAKE_VENDOR_KEY: SERVER_KEY }, log: (...line) => lines.push(line) } });
  await session.send('a');
  assert.equal((await session.turnEnd()).status, 'completed');
  const said = fakeEvents(recipe);
  const auth = said.find((e) => e.type === 'authenticate');
  assert.equal(auth?.methodId, API_KEY);
  assert.equal(auth.sha, sha(KEY), "the harness's key, never the server's");
  assert.ok(said.findIndex((e) => e.type === 'authenticate') < said.findIndex((e) => e.type === 'new'), 'before the session opened');
  const left = await leftBehind(store, events, lines);
  assert.equal(left.includes(KEY) || left.includes(SERVER_KEY), false);
});

test("an attended run on a person's sign-in: authenticate before session/new, the agent reads its own folder, nothing of it mirrored or kept", async (t) => {
  const dir = scratch();
  const folder = loginFolder(dir);
  const recipe = attended(dir, folder);
  const lines = [];
  const { session, store, events } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH }, log: (...line) => lines.push(line) } });
  await session.send('a');
  assert.equal((await session.turnEnd()).status, 'completed');
  const said = fakeEvents(recipe);
  const auth = said.find((e) => e.type === 'authenticate');
  assert.equal(auth?.methodId, LOGIN);
  assert.equal(auth.sha, sha(TOKEN), "the person's own sign-in, read by the agent where it left it");
  assert.ok(said.findIndex((e) => e.type === 'authenticate') < said.findIndex((e) => e.type === 'new'));
  await session.close();
  const mirrored = (await streamRecords(store, STATE_STREAM)).map((r) => r.path);
  assert.ok(mirrored.length > 0, 'the session store was mirrored');
  assert.equal(JSON.stringify(mirrored).includes('token'), false, mirrored.join(', '));
  assert.equal((await leftBehind(store, events, lines)).includes(TOKEN), false, 'no record, event or log line holds the token');
  assert.equal(readFileSync(join(folder, 'token.json'), 'utf8'), `${TOKEN}\n`, "the folder is the agent's, never the adapter's to move");
});

test('an attended run whose agent dies printing its token keeps none of its stderr: the failure says its exit status and our code', async (t) => {
  const dir = scratch();
  const recipe = attended(dir, loginFolder(dir), { leak: 'exit' });
  const lines = [];
  const { session, store, events } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH }, log: (...line) => lines.push(line) } });
  await session.send('a');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, new RegExp(`^${ACP_CODES.agentExited}: `), end.error);
  assert.match(end.error, /exit status 1/, end.error);
  assert.equal(/vendor refused/.test(end.error), false, `no word the agent printed: ${end.error}`);
  const left = await leftBehind(store, events, lines);
  assert.equal(left.includes(TOKEN) || left.includes('vendor refused'), false);
});

test('an attended run whose agent answers an error holding its token keeps none of those words: the JSON-RPC code alone', async (t) => {
  const dir = scratch();
  const recipe = attended(dir, loginFolder(dir), { leak: 'answer' });
  const lines = [];
  const { session, store, events } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH }, log: (...line) => lines.push(line) } });
  await session.send('a');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, /the agent answered error -32603/, end.error);
  const left = await leftBehind(store, events, lines);
  assert.equal(left.includes(TOKEN) || left.includes('vendor refused'), false);
});

test("the same agent on a run that keeps its stderr says its last words: the hushed runs' silence is the recipe's, not the agent's", async (t) => {
  const dir = scratch();
  const recipe = attended(dir, loginFolder(dir), { leak: 'exit', stderr: 'tail' });
  const { session } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH } } });
  await session.send('a');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, /vendor refused the sign-in/, end.error);
});

test('a sign-in method the agent does not list is refused before any session opens', async (t) => {
  const dir = scratch();
  const recipe = attended(dir, loginFolder(dir), { method: 'another-login' });
  const { session } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH } } });
  await session.send('a');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, new RegExp(`^${ACP_CODES.authUnlisted}: `), end.error);
  assert.match(end.error, /another-login/);
  assert.match(end.error, /fake-login, fake-api-key/, 'the methods it lists');
  assert.equal(fakeEvents(recipe).some((e) => e.type === 'new' || e.type === 'authenticate'), false);
});

test('a sign-in the agent refuses (its owner never signed in) is refused before any session opens, its words kept nowhere', async (t) => {
  const dir = scratch();
  const recipe = attended(dir, loginFolder(dir, false));
  const { session } = await openSession(t, recipe, { options: { env: { PATH: process.env.PATH } } });
  await session.send('a');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, new RegExp(`^${ACP_CODES.authFailed}: `), end.error);
  assert.match(end.error, /the agent answered error -32000/, end.error);
  assert.equal(fakeEvents(recipe).some((e) => e.type === 'new'), false);
});

test("the recipe's sign-in fields are checked: the name a key is handed as, the method's id, stderr", () => {
  const base = { id: 'x', command: '/bin/true', declares: { load: false, mcp: 'http' }, billing: { kind: 'plan', maxTurns: 1, maxToolCalls: 0 } };
  assert.deepEqual(recipeProblems({ ...base, keys: ['X_KEY'], keyEnv: { X_KEY: 'GEMINI_API_KEY' }, authMethod: 'gemini-api-key', stderr: 'none' }), []);
  assert.match(recipeProblems({ ...base, keys: ['X_KEY'], keyEnv: { X_KEY: 'HOME' } }).join(' '), /a variable the adapter sets/);
  assert.match(recipeProblems({ ...base, keys: ['X_KEY'], keyEnv: { X_KEY: 'lower case' } }).join(' '), /not a variable's name/);
  assert.match(recipeProblems({ ...base, keys: ['A_KEY', 'B_KEY'], keyEnv: { A_KEY: 'GEMINI_API_KEY', B_KEY: 'GEMINI_API_KEY' } }).join(' '), /two keys are handed as GEMINI_API_KEY/);
  assert.match(recipeProblems({ ...base, keys: ['X_KEY'], keyEnv: { X_KEY: 'GEMINI_API_KEY' }, env: { GEMINI_API_KEY: 'x' } }).join(' '), /also in env/);
  assert.match(recipeProblems({ ...base, keyEnv: { X_KEY: 'GEMINI_API_KEY' } }).join(' '), /not one of the keys/);
  assert.match(recipeProblems({ ...base, authMethod: '' }).join(' '), /not a method's id/);
  assert.match(recipeProblems({ ...base, stderr: 'all' }).join(' '), /"tail" or "none"/);
});

/** Variables a dynamic loader, an interpreter, a shell or git reads before the agent's own code runs: one of each kind. */
const LAUNCHERS = ['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'BASH_ENV', 'ENV', 'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND'];

test("no key is handed as, and no env sets, a variable that changes what the agent's process loads or runs (the kernel's one list)", async () => {
  const { launchEnv } = await import('@parcha/agentrun-kernel');
  const base = { id: 'x', command: '/bin/true', declares: { load: false, mcp: 'http' }, billing: { kind: 'plan', maxTurns: 1, maxToolCalls: 0 } };
  for (const name of LAUNCHERS) {
    assert.equal(launchEnv(name), true, `${name} is on the list`);
    assert.match(recipeProblems({ ...base, keys: ['X_KEY'], keyEnv: { X_KEY: name } }).join(' '), /loads or runs/, `a key handed as ${name}`);
    assert.match(recipeProblems({ ...base, env: { [name]: 'x' } }).join(' '), /loads or runs|the adapter sets/, `env setting ${name}`);
  }
  assert.match(recipeProblems({ ...base, keys: ['LD_PRELOAD'] }).join(' '), /loads or runs/, 'a key under its own name');
  for (const name of ['GEMINI_API_KEY', 'GEMINI_HOME', 'MY_ENV', 'NODEJS_HOME', 'PATHS']) assert.equal(launchEnv(name), false, `${name} is not`);
});

test("a sign-in whose agent answers initialize with an error says its JSON-RPC code alone, none of its words", async () => {
  const { signInAgent } = await import('@parcha/agentrun-harness-acp');
  const dir = scratch();
  const agent = join(dir, 'refuses-initialize.mjs');
  writeFileSync(agent, [
    "import { createInterface } from 'node:readline';",
    'for await (const line of createInterface({ input: process.stdin })) {',
    '  const { id } = JSON.parse(line);',
    `  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'refused, signed in as ${TOKEN}' } }) + '\\n');`,
    '}',
  ].join('\n'));
  const home = join(dir, 'home');
  mkdirSync(home);
  await assert.rejects(signInAgent({ command: process.execPath, args: [agent], method: LOGIN, homeEnv: 'FAKE_LOGIN_HOME', home }), (error) => {
    assert.equal(error.message.includes(TOKEN), false, error.message);
    assert.equal(error.message.includes('signed in as'), false, error.message);
    assert.match(error.message, new RegExp(`^${ACP_CODES.authFailed}: [^\\n]*initialize[^\\n]*-32603`));
    return true;
  });
});

test("a sign-in never points the agent's folder variable at one that changes what it loads or runs, nor one the adapter sets: refused before it starts", async () => {
  const { signInAgent } = await import('@parcha/agentrun-harness-acp');
  const dir = scratch();
  for (const homeEnv of [...LAUNCHERS, 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME']) {
    await assert.rejects(signInAgent({ command: join(dir, 'never-started'), args: [], method: LOGIN, homeEnv, home: dir }), (error) => error.message.startsWith(`${ACP_CODES.authFailed}: `) && error.message.includes(homeEnv), homeEnv);
  }
});
