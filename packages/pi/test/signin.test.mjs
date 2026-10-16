// @parcha/agentrun-pi/signin on fakes: the token store and its refresh lock, the sign-in, the model choice, the plan's
// usage limit and the eyes model. OpenAI's hosts go to a local fake through a replaced global fetch (child processes
// get it from fixtures/signin-refresh-child.mjs); a request to any other host fails the test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { after, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowExtension, recordingLines } from '@parcha/agentrun-pi/durable';
import { AGENT_NAME, AuthStoreError, checkKeys, fileCredentialStore, resolveModel, ResolveError, SignInError, signIn, UsageLimitError, usageLimitError } from '@parcha/agentrun-pi/signin';
import { fakeOpenAI } from './fixtures/fake-openai.mjs';

const root = mkdtempSync(join(tmpdir(), 'agentrun-signin-'));
after(() => rmSync(root, { recursive: true, force: true }));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A home that does not exist yet, so the store makes it. */
const newHome = () => join(mkdtempSync(join(root, 'case-')), 'agentrun');
const oauth = (over = {}) => ({ type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: Date.now() + 3_600_000, clientId: 'oaiapp_test', scopes: ['chatgpt.tokens.use.direct'], ...over });
function seed(home, credential) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ version: 1, hostId: randomUUID(), credentials: { openai: credential } }), { mode: 0o600 });
}
const stored = (home) => JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));

// The account's list is drawn from the installed pi-ai catalog: one model with image input, one without, one pi-ai
// does not know and one the account does not list as visible.
const catalog = openaiProvider().getModels();
const seeing = catalog.find((model) => model.input.includes('image'));
const blind = catalog.find((model) => !model.input.includes('image'));
const LISTED = [
  { id: blind.id, object: 'model', created: 300, visibility: 'list' },
  { id: seeing.id, object: 'model', created: 200, visibility: 'list' },
  { id: 'not-in-the-catalog', object: 'model', created: 900, visibility: 'list' },
  { id: seeing.id === catalog[0].id ? catalog[1].id : catalog[0].id, object: 'model', created: 999, visibility: 'hidden' },
];
/** The pi-ai this package loads: the nearest node_modules copy above it. pi-ai passes `agentName` on from 1.1. */
const piAiVersion = (() => {
  for (let at = realpathSync(fileURLToPath(new URL('..', import.meta.url))); ; at = dirname(at)) {
    const manifest = join(at, 'node_modules', '@earendil-works/pi-ai', 'package.json');
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')).version;
    if (at === dirname(at)) throw new Error('pi-ai does not resolve from the package');
  }
})();
const namesTheApp = (([major, minor]) => major > 1 || minor >= 1)(piAiVersion.split('.').map(Number));
const LOCK_HOLDER = fileURLToPath(new URL('./fixtures/signin-lock-holder.mjs', import.meta.url));
const spec = (models = { lead: { needs: ['text', 'tools'] } }) => ({ name: 'signin-test', models, keys: [], programs: [], expectedCalls: 4, expectedCost: 0.05 });

async function fake(t, options) {
  const server = await fakeOpenAI({ models: LISTED, ...options });
  globalThis.fetch = server.fetch;
  t.after(server.close);
  return server;
}

/** One request through pi-ai with the resolved key, as a demo makes it. */
async function ask(resolved) {
  const models = createModels();
  models.setProvider(openaiProvider());
  return models.completeSimple(resolved.model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }, { apiKey: await resolved.getApiKey() });
}

test('an expired access token is refreshed once, then the request goes through with the new token', async (t) => {
  const server = await fake(t);
  const home = newHome();
  seed(home, oauth({ expires: Date.now() - 1000 }));
  const resolved = await resolveModel(spec(), { home, env: {} });
  const refreshed = stored(home).credentials.openai;
  assert.deepEqual(server.seen.refreshSent, ['refresh-1'], 'one refresh, with the stored refresh token');
  assert.notEqual(refreshed.access, 'access-1');
  assert.notEqual(refreshed.refresh, 'refresh-1', 'the rotated refresh token is stored');
  assert.equal(resolved.source, 'chatgpt');
  assert.equal(resolved.model.id, blind.id, 'the newest listed model pi-ai knows that meets the needs');
  const message = await ask(resolved);
  assert.equal(message.stopReason, 'stop', message.errorMessage);
  assert.equal(message.content.map((block) => block.text).join(''), 'hello');
  assert.deepEqual(server.seen.responses.map((request) => request.authorization), [`Bearer ${refreshed.access}`]);
  assert.equal(server.seen.responses[0].body.store, false);
  assert.deepEqual(server.seen.refreshSent, ['refresh-1'], 'the request reused the refreshed token');
  assert.equal(await server.probe(), 404);
  assert.equal(server.seen.foreign, 1, 'a request without this test\'s secret is not one of its own');
});

/** A child of this test, gone when the test ends: killed and waited for on every path out of the test. */
function owned(t, proc) {
  t.after(async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGKILL');
    await once(proc, 'exit');
  });
  return proc;
}

/** Whether process `pid` is gone. */
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };

/** Two processes resolving the model at once behind a barrier, each through fixtures/signin-refresh-child.mjs. */
async function refreshPair(t, server, home) {
  const barrier = mkdtempSync(join(root, 'barrier-'));
  const child = fileURLToPath(new URL('./fixtures/signin-refresh-child.mjs', import.meta.url));
  const run = (name) => new Promise((done, fail) => {
    const proc = owned(t, spawn(process.execPath, [child, home, barrier, name], { env: { ...process.env, FAKE_OPENAI_BASE: server.base, FAKE_OPENAI_SECRET: server.secret }, stdio: ['pipe', 'pipe', 'pipe'] }));
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.stderr.on('data', (chunk) => { err += chunk; });
    proc.on('error', fail);
    proc.on('exit', (code) => code === 0 ? done(JSON.parse(out)) : fail(new Error(`${name} exited ${code}: ${err}`)));
  });
  const both = Promise.all([run('a'), run('b')]);
  while (!(existsSync(join(barrier, 'ready-a')) && existsSync(join(barrier, 'ready-b')))) await new Promise((done) => setTimeout(done, 5));
  writeFileSync(join(barrier, 'go'), '');
  return both;
}

/** One refresh between the two, the rotated token in both, and auth.json beside its empty lock database. */
function refreshedOnce(server, home, a, b) {
  assert.deepEqual(server.seen.refreshSent, ['refresh-1'], 'one refresh between them');
  assert.deepEqual(server.seen.reused, []);
  const hash = createHash('sha256').update(stored(home).credentials.openai.access).digest('hex');
  assert.equal(a.key, hash);
  assert.equal(b.key, hash);
  assert.deepEqual(readdirSync(home).sort(), ['auth.json', 'auth.json.lock'], 'no temporary file is left');
  const lock = statSync(join(home, 'auth.json.lock'));
  assert.equal(lock.mode & 0o777, 0o600);
  assert.equal(lock.size, 0, 'the lock holds nothing');
}

test('two processes refreshing at once: one refreshes, the other re-reads; both hold the new token, and no refresh token is sent twice', async (t) => {
  const server = await fakeOpenAI({ models: LISTED, tokenDelayMs: 400 });
  t.after(server.close);
  const home = newHome();
  seed(home, oauth({ expires: Date.now() - 1000 }));
  const [a, b] = await refreshPair(t, server, home);
  assert.ok(a.started < b.finished && b.started < a.finished, 'the two resolutions overlapped');
  refreshedOnce(server, home, a, b);
});

test('a writer killed while it holds the lock: the lock is free at once, and of the next two processes one refreshes', async (t) => {
  const server = await fakeOpenAI({ models: LISTED, tokenDelayMs: 400 });
  t.after(server.close);
  const home = newHome();
  seed(home, oauth({ expires: Date.now() - 1000 }));
  const holder = owned(t, spawn(process.execPath, ['--expose-gc', LOCK_HOLDER, home], { stdio: ['pipe', 'pipe', 'inherit'] }));
  await new Promise((done, fail) => { holder.stdout.on('data', (chunk) => String(chunk).includes('held') && done()); holder.on('exit', (code) => fail(new Error(`the holder exited ${code}`))); });
  await new Promise((done) => setTimeout(done, 200)); // garbage collections run in the holder meanwhile
  await assert.rejects(fileCredentialStore(home, { lockTimeoutMs: 300 }).hostId(), (error) => error instanceof AuthStoreError && error.code === 'LOCK_TIMEOUT', 'held: a writer waits');
  holder.kill('SIGKILL');
  await once(holder, 'exit');
  assert.ok(gone(holder.pid), 'the holder is gone');
  const started = Date.now();
  const [a, b] = await refreshPair(t, server, home);
  assert.ok(Date.now() - started < 20_000, 'nobody waited out a lock timeout');
  refreshedOnce(server, home, a, b);
});

test('a lock holder whose test process dies leaves on its own: no holder outlives its test', async (t) => {
  const home = newHome();
  // A stand-in for the test process: it starts a holder the way the test above does, reports the holder's pid, and is
  // then killed outright, with no chance to clean up.
  const parent = owned(t, spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const holder = spawn(process.execPath, ['--expose-gc', ${JSON.stringify(LOCK_HOLDER)}, ${JSON.stringify(home)}], { stdio: ['pipe', 'pipe', 'inherit'] });
    holder.stdout.on('data', (chunk) => String(chunk).includes('held') && process.stdout.write(holder.pid + '\\n'));
    setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] }));
  const pid = Number((await once(parent.stdout, 'data'))[0]);
  t.after(() => {
    // Only if this test failed: the holder by its pid, after checking it is still this test's holder.
    let cmdline = '';
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch {}
    if (!gone(pid) && cmdline.includes('signin-lock-holder.mjs')) process.kill(pid, 'SIGKILL');
  });
  assert.ok(pid > 0 && !gone(pid), 'the holder is running');
  parent.kill('SIGKILL');
  await once(parent, 'exit');
  const deadline = Date.now() + 10_000;
  while (!gone(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  assert.ok(gone(pid), 'the holder left when its parent died');
});

test('port 1455 busy: the sign-in fails at once with the clear message, and stores no credential', async (t) => {
  await fake(t);
  const holder = createServer();
  // Held here, or already held by another process: either way the sign-in finds it taken.
  const held = await new Promise((done, fail) => {
    holder.once('error', (error) => error.code === 'EADDRINUSE' ? done(false) : fail(error));
    holder.listen(1455, '127.0.0.1', () => done(true));
  });
  t.after(() => held && holder.close());
  const home = newHome();
  const events = [];
  const started = Date.now();
  await assert.rejects(
    signIn({ home, interaction: { notify: (event) => events.push(event.type), prompt: () => new Promise(() => {}) } }),
    (error) => {
      assert.ok(error instanceof SignInError, String(error));
      assert.equal(error.code, 'PORT_IN_USE');
      assert.match(error.message, /Port 1455 is in use/);
      assert.match(error.message, /\nFinish or cancel the other login, then run again\.$/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, 'no hang');
  assert.deepEqual(events, [], 'no sign-in page was offered');
  assert.deepEqual(stored(home).credentials, {});
});

test('the plan\'s usage limit: the typed error, and one request, at the start or mid-stream', async (t) => {
  for (const responses of ['limit', 'limit-midstream']) {
    const server = await fake(t, { responses });
    const home = newHome();
    seed(home, oauth());
    const message = await ask(await resolveModel(spec(), { home, env: {} }));
    assert.equal(message.stopReason, 'error');
    const error = usageLimitError(message);
    assert.ok(error instanceof UsageLimitError, `${responses}: ${message.errorMessage}`);
    assert.equal(error.message, 'Your ChatGPT plan\'s usage limit is reached; wait, or set a provider key.');
    assert.equal(server.seen.responses.length, 1, `${responses}: one request, no retry`);
  }
  assert.equal(usageLimitError(new Error('429 Too Many Requests')), undefined, 'a rate limit is not the plan\'s limit');
});

test('a stored sign-in, OPENAI_API_KEY set and --provider openai: the explicit key wins', async (t) => {
  const server = await fake(t);
  const home = newHome();
  seed(home, oauth({ expires: Date.now() - 1000 }));
  const before = readFileSync(join(home, 'auth.json'), 'utf8');
  const resolved = await resolveModel(spec(), { home, provider: 'openai', env: { OPENAI_API_KEY: 'fake-test-key' } });
  assert.equal(resolved.source, 'flag');
  assert.equal(resolved.apiKey, 'fake-test-key');
  assert.equal(resolved.model.id, blind.id);
  assert.deepEqual(server.seen.models, ['Bearer fake-test-key'], 'the account list was read with the explicit key');
  assert.deepEqual(server.seen.token, [], 'the stored sign-in was not refreshed');
  assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), before);
  await assert.rejects(resolveModel(spec(), { home, provider: 'openai', env: {} }), (error) => error instanceof ResolveError && error.code === 'MISSING_KEY' && /OPENAI_API_KEY/.test(error.message));
  await assert.rejects(resolveModel(spec(), { home, provider: 'anthropic', model: 'any', env: { ANTHROPIC_OAUTH_TOKEN: 'not-a-secret' } }), (error) => error.code === 'MISSING_KEY' && /ANTHROPIC_API_KEY/.test(error.message));
});

const WORKFLOW = {
  v: 2, name: 'signed-in',
  schemas: {
    Asked: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' }, model: { type: 'object' } } },
    Out: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
  },
  output: { schemaId: 'Out', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'call', label: 'ask', via: 'tool', tool: 'model.ask', args: {}, out: 'Asked', as: 'asked', deadline_s: 20 },
    { node: 'code', label: 'answer', code: 's => ({ result: { answer: s.asked.answer } })' },
  ] },
};

test(`a sign-in on fakes (pi-ai ${piAiVersion}): auth.json is 0600 in a 0700 directory, and a recording made after it scans clean`, async (t) => {
  const server = await fake(t);
  const home = newHome();
  let page;
  const shown = [];
  const interaction = {
    notify: (event) => { shown.push(event.type); if (event.type === 'auth_url') page = new URL(event.url); },
    prompt: async () => `http://127.0.0.1:1455/auth/callback?code=code-1&state=${page.searchParams.get('state')}&client_id=oaiapp_test`,
  };
  let signed;
  if (namesTheApp) {
    signed = await signIn({ home, interaction });
    assert.equal(page.searchParams.get('agent_name_hint'), AGENT_NAME);
    assert.deepEqual(server.seen.codes, ['code-1']);
  } else {
    await assert.rejects(signIn({ home, interaction }), (error) => error instanceof SignInError && error.code === 'APP_NAME_IGNORED' && error.message.includes('names "Pi" on the sign-in page instead of "AgentRun"'));
    assert.deepEqual(shown, [], 'the page naming another app is never shown');
    assert.deepEqual(server.seen.codes, [], 'no code was exchanged');
    assert.deepEqual(stored(home).credentials, {});
    // The rest runs on a sign-in written as the store writes one.
    const { hostId } = stored(home);
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ version: 1, hostId, credentials: { openai: oauth({ access: `access-${randomUUID()}`, refresh: `refresh-${randomUUID()}` }) } }));
    signed = { home, provider: 'openai', hostId };
  }
  const file = stored(home);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'auth.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home).sort(), ['auth.json', 'auth.json.lock']);
  if (namesTheApp) assert.equal(page.searchParams.get('ext_agent_host_id'), `urn:uuid:${file.hostId}`, 'the persisted host id');
  assert.equal(signed.hostId, file.hostId);
  const { access, refresh } = file.credentials.openai;

  const resolved = await resolveModel(spec(), { home, env: {} });
  assert.equal(resolved.apiKey, access);
  const db = join(mkdtempSync(join(root, 'run-')), 'run.sqlite');
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const flow = createWorkflowExtension({
    options: () => ({ files }),
    run: () => ({ adapters: { runEffect: async () => {
      const message = await ask(resolved);
      return { answer: message.content.map((block) => block.text).join(''), model: resolved };
    } } }),
  });
  const registry = createRegistry();
  registry.install(flow.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(db), { registry, models: {} }, ctx);
  try { await (await flow.start(harness, { key: 'signed-in', workflow: WORKFLOW, input: {} }, ctx)).wait(ctx); } finally { await harness.close(ctx); }
  const recording = JSON.stringify(recordingLines(db).lines);
  assert.ok(recording.includes('"answer":"hello"') && recording.includes(resolved.model.id), 'the run and its model are in the recording');
  assert.ok(!recording.includes(access), 'no access token in the recording');
  assert.ok(!recording.includes(refresh), 'no refresh token in the recording');
  for (const shown of [JSON.stringify(resolved), inspect(resolved, { depth: 5 }), JSON.stringify(signed)]) {
    assert.ok(!shown.includes(access) && !shown.includes(refresh), shown);
  }
});

test('the eyes model: the lead\'s when it meets the needs, else refused naming the gap', async (t) => {
  await fake(t);
  const home = newHome();
  seed(home, oauth());
  await assert.rejects(resolveModel(spec({ lead: { needs: ['text'] }, eyes: { needs: ['video'] } }), { home, env: {} }), (error) => {
    assert.ok(error instanceof ResolveError && error.code === 'EYES', String(error));
    assert.match(error.message, /eyes need video input: the ChatGPT plan takes no video input/);
    assert.match(error.message, /--eyes-model/);
    return true;
  });
  await assert.rejects(resolveModel(spec({ lead: { needs: ['text'] }, eyes: { needs: ['images'] } }), { home, env: {} }), (error) => error.code === 'EYES' && error.message.includes(`the lead model ${blind.id} takes no image input`));
  const lead = await resolveModel(spec({ lead: { needs: ['text', 'images'] }, eyes: { needs: ['images'] } }), { home, env: {} });
  assert.equal(lead.model.id, seeing.id);
  assert.equal(lead.eyes.source, 'lead');
  assert.equal(lead.eyes.model.id, seeing.id);
  const flagged = await resolveModel(spec({ lead: { needs: ['text'] }, eyes: { needs: ['images'] } }), { home, env: { OPENAI_API_KEY: 'test-key' }, eyes: { provider: 'openai', model: seeing.id } });
  assert.equal(flagged.eyes.source, 'flag');
  assert.equal(flagged.eyes.apiKey, 'test-key');
  const report = checkKeys(spec({ lead: { needs: ['text'] }, eyes: { needs: ['video'] } }), { env: {}, live: true });
  assert.equal(report.exitCode, 2);
  assert.match(report.text, /MISSING  model eyes: the run's eyes read video\n {11}the ChatGPT plan takes no video input/);
  assert.equal(checkKeys(spec({ lead: { needs: ['text'] }, eyes: { needs: ['video'] } }), { env: {}, live: true, eyes: { provider: 'google', model: 'x' } }).exitCode, 0);
});
