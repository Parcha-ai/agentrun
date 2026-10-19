// The web example's agent app, offline: no network, no key, no model call. Runs are started in a real agent home with
// @parcha/pi-durable-agent, a run's Harness is opened on its store with the options the app returns, and its root
// conversation is created the way the serve door creates it, after the app's `beforeResume`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defineDocFamily } from '@earendil-works/pi-durable';
import { carryBack, readAgentHome, startRun } from '@parcha/pi-durable-agent';
import { archilEnv } from '@parcha/pi-durable-disk';
import { frameRecorder } from '@parcha/pi-browser/recorder';
import { fakeCdp, jpeg as fakeJpeg } from '../../../packages/pi-browser/test/fixtures/fake-cdp.mjs';
import { browserOptions, createAgent, liveOf, NO_LOCAL_VIEW, PROFILE, promptOf, signInAsked, signInSite, toolsOf } from './app.ts';
import { CHROME_PROFILE, chromeArgs, chromeProfileFor, startChrome } from './chrome.ts';
import { frameStore } from './frames.ts';
import { ensureAgentHome } from './home.mjs';

const ENV = { BROWSERBASE_API_KEY: 'unused', AGENT_MODEL_BASE_URL: 'http://127.0.0.1:9/v1', AGENT_MODEL: 'test-model' };

async function agentHome(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'web-agent-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  return { tmp, home: await ensureAgentHome(join(tmp, 'home')) };
}

/** Run `runId` started in `home`, as pi-durable-disk hands it to the app. */
async function started(home, runId) {
  const run = await startRun(home, { runId, host: 'test' });
  return { run, where: { ref: { disk: 'local', region: 'local', id: runId }, root: run.dir, work: run.workspace, store: dirname(run.storePath) } };
}

/** The app's options on the run's own store, `beforeResume` included, as pi-durable-disk opens a run; `env` gives the
 *  file tools their workspace, confined to work/ as pi-durable-disk confines a run's. */
async function open(t, run, options, { env = false } = {}) {
  const harness = await Harness.open(await openNodeSqliteStorage(run.storePath), { models: options.models, registry: options.registry, onReport: () => {}, ...(env ? { env: archilEnv({ root: run.dir, work: run.workspace }, { noNewPrivs: false }) } : {}) }, ctx);
  t.after(() => harness.close(ctx).catch(() => {}));
  await options.beforeResume({ harness, context: ctx });
  return harness;
}

test('the home is made from agent.json and the skills: the definition names no model, and the prompt carries each skill in order', async (t) => {
  const { tmp, home } = await agentHome(t);
  const state = await readAgentHome(home);
  assert.equal(state.identity.id, 'site-reporter');
  assert.deepEqual(Object.keys(state.skills).sort(), ['memory/SKILL.md', 'sign-in/SKILL.md', 'site-report/SKILL.md']);
  const prompt = promptOf(state);
  assert.ok(prompt.indexOf('<skill name="sign-in">') < prompt.indexOf('<skill name="site-report">'), 'skills follow the definition order');
  assert.equal((await stat(home.dir)).mode & 0o777, 0o700, 'the home holds sign-ins: owner only');

  const agentDir = join(tmp, 'agent');
  await cp(import.meta.dirname, agentDir, { recursive: true, filter: (from) => !from.endsWith('.test.mjs') });
  const good = JSON.parse(await readFile(join(agentDir, 'agent.json'), 'utf8'));
  await writeFile(join(agentDir, 'agent.json'), JSON.stringify({ ...good, model: 'any' }));
  await assert.rejects(ensureAgentHome(join(tmp, 'other'), agentDir), /fields it does not keep: model/);
  assert.throws(() => toolsOf({ tools: ['read', 'bash'] }, { coding: [{ name: 'read' }] }), /names the tool bash/);
  assert.throws(() => promptOf({ definition: { ...state.definition, skills: ['missing'] }, skills: {} }), /no missing\/SKILL\.md/);
});

test('the skills and the definition name no site: no address, domain or path of one, so no example in them reads as a step the run took', async () => {
  const skills = (await readdir(join(import.meta.dirname, 'skills'))).map((name) => `skills/${name}/SKILL.md`);
  for (const file of ['agent.json', ...skills]) {
    const text = await readFile(join(import.meta.dirname, file), 'utf8');
    for (const [what, pattern] of [['an address', /[a-z]+:\/\//i], ['a domain', /\b[a-z0-9-]+\.(?:com|org|net|io|dev|app|ai|co|edu|gov)\b/i], ['a site path', /(?<![\w./])\/[a-z][\w-]*/i]]) {
      assert.doesNotMatch(text, pattern, `${file} names ${what}`);
    }
  }
});

test('run 1 makes the browser profile once, the root conversation carries it, and carryBack gives it to run 2, which makes none', async (t) => {
  const { home } = await agentHome(t);
  let made = 0;
  const makeContext = async () => (made++, 'ctx-made-by-run-1');

  const one = await started(home, 'run-1');
  const { options, browser } = await createAgent(one.where, ENV, { makeContext });
  const harness = await open(t, one.run, options);
  const root = await harness.root(ctx, options.root);
  const config = await harness.snapshot(browser.docs.Config, root.id, ctx);
  assert.deepEqual([made, config.run, config.policy.contextId, config.policy.idleReleaseS], [1, 'run-1', 'ctx-made-by-run-1', 900]);
  const agent = await root.agent(ctx);
  assert.deepEqual(agent.tools.map((tool) => tool.name), ['read', 'write', 'edit', 'snapshot', 'run', 'browser_read', 'browser_release', 'request_sign_in']);
  assert.deepEqual([agent.model, agent.thinkingLevel], [{ provider: 'agent-model', modelId: 'test-model' }, 'medium']);
  assert.doesNotMatch(agent.instructions, /ctx-made-by-run-1/, 'the context id never reaches the model');
  await harness.close(ctx);
  assert.deepEqual((await carryBack(home, one.run, { outcome: 'completed' })).profiles, [PROFILE]);
  assert.equal((await readAgentHome(home)).profiles[PROFILE].ref, 'ctx-made-by-run-1');

  const two = await started(home, 'run-2');
  assert.deepEqual(two.run.leases, [PROFILE], 'run 2 holds the save lease');
  const second = await createAgent(two.where, ENV, { makeContext: async () => assert.fail('run 2 starts signed in: it makes no profile') });
  const harness2 = await open(t, two.run, second.options);
  const root2 = await harness2.root(ctx, second.options.root);
  assert.equal((await harness2.snapshot(second.browser.docs.Config, root2.id, ctx)).policy.contextId, 'ctx-made-by-run-1');
  assert.equal(made, 1);
});

test('the root conversation is never created before the profile is resolved', async (t) => {
  const { home } = await agentHome(t);
  const one = await started(home, 'run-1');
  const { options } = await createAgent(one.where, ENV, { makeContext: async () => 'ctx-1' });
  const harness = await Harness.open(await openNodeSqliteStorage(one.run.storePath), { models: options.models, registry: options.registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx).catch(() => {}));
  await assert.rejects(harness.root(ctx, options.root), /resolved before the root conversation/);
});

test('request_sign_in ends the turn: no model request and no tool runs until the person replies', async (t) => {
  const { home } = await agentHome(t);
  const one = await started(home, 'run-1');
  const { options } = await createAgent(one.where, ENV, { makeContext: async () => 'ctx-1' });
  let asked = 0;
  const faux = fauxProvider({ models: [{ id: 'scripted' }] });
  faux.setResponses([
    () => (asked++, fauxAssistantMessage([fauxToolCall('request_sign_in', { site: 'the practice site', reason: 'The secure page needs a sign-in.' }, { id: 'call-1' })], { stopReason: 'toolUse' })),
    () => (asked++, fauxAssistantMessage([fauxText('this answer must never be asked for')], { stopReason: 'stop' })),
  ]);
  options.models.setProvider(faux.provider);
  const harness = await open(t, one.run, options);
  const root = await harness.root(ctx, { ...options.root, agent: { ...options.root.agent, model: { provider: faux.provider.id, modelId: 'scripted' } } });
  const settled = await (await root.submit({ type: 'input', content: 'Log in and report.', requestId: 'ask-1' }, ctx)).wait(ctx);

  assert.equal(settled.status, 'done');
  assert.equal(asked, 1, 'the run ended on the tool result, without another model request');
  const newest = (await root.entries({}, 1, undefined, ctx)).items[0];
  assert.equal(newest.kind, 'pi.tool-result');
  assert.deepEqual(newest.model[0].content, [{ type: 'text', text: signInAsked('the practice site') }]);
});

test('thinking is never off, and the model and the key come from the host', async (t) => {
  const { home } = await agentHome(t);
  const { where } = await started(home, 'run-1');
  await assert.rejects(createAgent(where, { ...ENV, AGENT_THINKING: 'off' }), /thinking is never off/);
  await assert.rejects(createAgent(where, { ...ENV, AGENT_MODEL: '' }), /AGENT_MODEL/);
  await assert.rejects(createAgent(where, { ...ENV, BROWSERBASE_API_KEY: '' }), /BROWSERBASE_API_KEY/);
});

test('live.json shows the live view while the session is open and nothing once it is released', () => {
  const row = { conversationId: 1, label: 'site-reporter', session: { resourceId: 'session-1' }, liveView: { fullscreen: 'https://live.example/full?t=x', framed: 'https://live.example/framed?t=x', pages: [] } };
  const at = new Date('2026-10-15T21:00:00Z');
  assert.deepEqual(liveOf(row, 'launched', at), { liveViewUrl: 'https://live.example/full?t=x', sessionId: 'session-1', change: 'launched', updatedAt: '2026-10-15T21:00:00.000Z' });
  assert.deepEqual(liveOf(row, 'released', at), { liveViewUrl: null, sessionId: 'session-1', change: 'released', updatedAt: '2026-10-15T21:00:00.000Z' });
  assert.equal(liveOf({ ...row, liveView: null }, 'updated', at).liveViewUrl, null);
});

// ---- the sign-in's site, and the browser's frames ------------------------------------------------------------------

const Profiles = defineDocFamily({ kind: 'browser.profiles', version: 1, scope: 'session', family: true, initial: () => ({}) });
const jpeg = (n) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n, 0xff, 0xd9]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** A frame line as the recorder hands it over, with its JPEG. */
const frame = (t, n) => [{ channel: 'live', source: 'browser', kind: 'frame', t, conv: 1, data: { session: 's1', provider: 'browserbase', w: 800, h: 500, mime: 'image/jpeg' }, blobs: [sha(jpeg(n))] }, { [sha(jpeg(n))]: jpeg(n) }];
const linesOf = async (dir) => (await readFile(join(dir, 'frames', 'frames.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

test('the sign-in\'s site: the page the browser is on, or an address the agent named; a name alone is no site', () => {
  assert.deepEqual(signInSite('the practice site', 'https://the-internet.herokuapp.com/login?next=%2Fsecure'), { origin: 'https://the-internet.herokuapp.com', startUrl: 'https://the-internet.herokuapp.com/login' });
  assert.deepEqual(signInSite('https://the-internet.herokuapp.com/login', null), { origin: 'https://the-internet.herokuapp.com', startUrl: 'https://the-internet.herokuapp.com/login' });
  assert.deepEqual(signInSite('the-internet.herokuapp.com', null), { origin: 'https://the-internet.herokuapp.com' });
  assert.equal(signInSite('the practice site', null), null);
  assert.equal(signInSite('localhost', null), null);
  assert.equal(signInSite('the practice site', 'about:blank'), null);
});

test('the hold starts when request_sign_in is called, before its result exists: a frame that arrives in between is dropped, and one gap marks it', async (t) => {
  const { home } = await agentHome(t);
  const one = await started(home, 'run-1');
  const { options, frames } = await createAgent(one.where, ENV, { makeContext: async () => 'ctx-1' });
  const tool = options.registry.snapshot().tools().find(({ tool }) => tool.name === 'request_sign_in').tool;
  const [a, aBlob] = frame(1_000, 1);
  await frames.sink(a, aBlob);
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  // The call is still on its first await (reading the profile) when the next frame comes: the run cannot show it waits yet.
  const api = { conversationId: 1, snapshot: () => gate.then(() => undefined), commit: async () => assert.fail('no ready profile, nothing to record') };
  const result = tool.execute({ site: 'https://the-internet.herokuapp.com/login', reason: 'The secure page needs a sign-in.' }, api, ctx);
  assert.equal(frames.held, true, 'held as the call starts');
  await assert.rejects(frames.sink(...frame(1_500, 2)), /not kept/, 'refused, so the recorder counts it dropped and no gap starts from it');
  open();
  assert.equal((await result).control.terminate, true);
  await assert.rejects(frames.sink(...frame(2_000, 3)), /not kept/, 'and still held once the run waits');
  frames.hold();
  await frames.flush();
  const lines = await linesOf(one.run.dir);
  assert.deepEqual(lines.map((l) => [l.seq, l.kind, l.t]), [[1, 'frame', 1_000], [2, 'frame.gap', lines[1].t]]);
  assert.deepEqual(lines[1].data, { session: 's1', from: 1_000, reason: 'credential_on_page', detail: 'host' });
  assert.deepEqual(await readdir(join(one.run.dir, 'frames', 'blobs')), [`${a.blobs[0]}.jpg`], 'no JPEG from the sign-in window');
});

test('frames are owner-only beside the run; the file tools cannot reach them; the agent\'s next step after the answer ends the hold; the site goes on the profile and back to the home', async (t) => {
  const { home } = await agentHome(t);
  const one = await started(home, 'run-1');
  const agent = await createAgent(one.where, ENV, { makeContext: async () => 'ctx-1' });
  const { options, frames } = agent;
  const dir = join(one.run.dir, 'frames');
  const [a, aBlob] = frame(1_000, 1);
  const attempts = [
    ['read', { path: '../frames/frames.jsonl' }],
    ['read', { path: join(dir, 'blobs', `${a.blobs[0]}.jpg`) }],
    ['write', { path: '../frames/frames.jsonl', content: 'x' }],
    ['edit', { path: '../frames/frames.jsonl', edits: [{ oldText: 'frame', newText: 'x' }] }],
  ];
  const faux = fauxProvider({ models: [{ id: 'scripted' }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('request_sign_in', { site: 'https://the-internet.herokuapp.com/login', reason: 'The secure page needs a sign-in.' }, { id: 'ask' })], { stopReason: 'toolUse' }),
    ...attempts.map(([name, args], i) => fauxAssistantMessage([fauxToolCall(name, args, { id: `try-${i}` })], { stopReason: 'toolUse' })),
    fauxAssistantMessage([fauxText('I could not read those.')], { stopReason: 'stop' }),
  ]);
  options.models.setProvider(faux.provider);
  const harness = await open(t, one.run, options, { env: true });
  const root = await harness.root(ctx, { ...options.root, agent: { ...options.root.agent, model: { provider: faux.provider.id, modelId: 'scripted' } } });

  await frames.sink(a, aBlob);
  assert.equal((await (await root.submit({ type: 'input', content: 'Log in and report.', requestId: 'ask-1' }, ctx)).wait(ctx)).status, 'done');
  await assert.rejects(frames.sink(...frame(5_000, 2)), /not kept/);
  assert.equal(frames.held, true, 'the run waits for the person: held');
  const asked = await harness.snapshot(Profiles, PROFILE, ctx);
  assert.deepEqual([asked.ref, asked.allowedOrigins, asked.startUrl, asked.verifiedAt], ['ctx-1', ['https://the-internet.herokuapp.com'], 'https://the-internet.herokuapp.com/login', undefined]);

  assert.equal((await (await root.submit({ type: 'input', content: 'done', requestId: 'ask-2' }, ctx)).wait(ctx)).status, 'done');
  const results = (await root.entries({}, 50, undefined, ctx)).items.filter((e) => e.kind === 'pi.tool-result' && e.model[0].toolCallId.startsWith('try-'));
  assert.equal(results.length, attempts.length);
  for (const r of results) assert.ok(r.model[0].isError && /outside the workspace/.test(JSON.stringify(r.model[0].content)), `${r.model[0].toolName} is refused`);
  assert.equal(frames.held, false, 'the agent\'s next step ended the hold');
  await frames.sink(...frame(9_000, 3));
  await frames.flush();
  assert.deepEqual((await linesOf(one.run.dir)).map((l) => [l.kind, l.t, l.data.detail ?? null]), [['frame', 1_000, null], ['frame.gap', (await linesOf(one.run.dir))[1].t, 'host'], ['frame', 9_000, null]]);

  for (const path of [dir, join(dir, 'blobs')]) assert.equal((await stat(path)).mode & 0o777, 0o700, `${relative(one.run.dir, path)} is owner-only`);
  for (const name of ['frames.jsonl', ...(await readdir(join(dir, 'blobs'))).map((f) => `blobs/${f}`)]) assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600, `frames/${name} is owner-only`);
  assert.ok(relative(one.run.workspace, dir).startsWith('..'), 'frames/ is not under work/');

  await agent.signIn.seen('https://elsewhere.example/');
  assert.equal((await harness.snapshot(Profiles, PROFILE, ctx)).verifiedAt, undefined, 'a page of another site verifies nothing');
  await agent.signIn.seen('https://the-internet.herokuapp.com/secure');
  const verified = (await harness.snapshot(Profiles, PROFILE, ctx)).verifiedAt;
  assert.ok(Date.parse(verified) > Date.now() - 60_000);
  await harness.close(ctx);
  await carryBack(home, one.run, { outcome: 'completed' });
  assert.deepEqual((await readAgentHome(home)).profiles[PROFILE], { provider: 'browserbase', ref: 'ctx-1', state: 'ready', allowedOrigins: ['https://the-internet.herokuapp.com'], startUrl: 'https://the-internet.herokuapp.com/login', verifiedAt: verified });
});

test('with the recorder itself: a frame refused during the hold never becomes where a gap starts; no line\'s t or from falls inside the hold', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'web-frames-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (check) => { for (const end = Date.now() + 4000; !check(); await sleep(10)) if (Date.now() > end) throw new Error('timed out'); };
  const started = Date.now();
  const clock = () => Date.now() - started;
  const store = frameStore(dir, clock);
  const recorder = frameRecorder({ sink: store.sink, clock });
  t.after(() => recorder.close());
  // A provider over the fake DevTools endpoint, as Browserbase's hands the recorder its session.
  const provider = {
    name: 'browserbase', caps: { timeoutModel: 'wall-clock', maxLifetimeS: 600, survivesDisconnect: true, releaseIsAsync: false, extension: 'loaded-locally' },
    async create(spec) { return { id: 'sess-1', tag: spec.tag }; }, async attach() { return { sdkCdpUrl: cdp.url }; }, async release() {}, async status() { return 'running'; }, async findByTag() { return []; },
  };
  const watched = recorder.watch(provider, 1);
  const signal = new AbortController().signal;
  const ref = await watched.create({ tag: 'ar-run-1-1', maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1280, height: 800 }, metadata: {} }, signal);
  await watched.attach(ref, signal);
  await until(() => cdp.screencasts().length === 1);
  const handled = () => recorder.stats().frames + recorder.stats().dropped;
  cdp.frame({ bytes: fakeJpeg(800, 500, 10, 1) });
  await until(() => handled() === 1);

  store.hold();
  const holdAt = clock();
  for (const tag of [2, 3]) {
    await sleep(150);
    cdp.frame({ bytes: fakeJpeg(800, 500, 10, tag) });
    await until(() => handled() === tag);
  }
  assert.deepEqual([recorder.stats().frames, recorder.stats().dropped], [1, 2], 'the recorder counts both frames of the sign-in as dropped');
  await sleep(50);
  const liftAt = clock();
  store.lift();
  // The page does not change after the sign-in: no frame comes, and the session is released.
  await watched.release(ref, signal);
  await recorder.close();
  await store.flush();
  const lines = (await readFile(join(dir, 'frames', 'frames.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((l) => [l.kind, l.data.reason ?? null, l.data.detail ?? null]), [['frame', null, null], ['frame.gap', 'credential_on_page', 'host'], ['frame.gap', 'session_released', null]]);
  const [kept, , released] = lines;
  assert.equal(released.data.from, kept.t, 'the release\'s gap starts at the last frame kept');
  const inside = (ms) => ms > holdAt && ms < liftAt;
  assert.deepEqual(lines.filter((l) => inside(l.t) || inside(l.data.from)), [], 'no line names a time inside the hold');
  assert.deepEqual(await readdir(join(dir, 'frames', 'blobs')), [`${kept.blobs[0]}.jpg`]);
});

const CHROME_ENV = { AGENT_MODEL_BASE_URL: ENV.AGENT_MODEL_BASE_URL, AGENT_MODEL: ENV.AGENT_MODEL, AGENT_BROWSER: 'chrome', AGENT_CHROME_ENDPOINT: 'http://127.0.0.1:9', AGENT_PAGE_ORIGIN: 'http://127.0.0.1:8787' };

test('the browser switch: Browserbase by default, the run\'s own Chrome by its loopback endpoint, anything else refused', () => {
  assert.equal(browserOptions(ENV).kind, 'browserbase');
  assert.deepEqual(browserOptions({ ...CHROME_ENV, AGENT_CHROME_ENDPOINT: 'http://127.0.0.1:41233' }), { kind: 'chrome', options: { endpoint: 'http://127.0.0.1:41233' } });
  assert.throws(() => browserOptions({ ...CHROME_ENV, AGENT_CHROME_ENDPOINT: 'http://10.0.0.5:41233' }), /127\.0\.0\.1/);
  assert.throws(() => browserOptions({ ...CHROME_ENV, AGENT_CHROME_ENDPOINT: '' }), /AGENT_CHROME_ENDPOINT/);
  assert.throws(() => browserOptions({ ...ENV, AGENT_BROWSER: 'firefox' }), /browserbase or chrome/);
  assert.throws(() => browserOptions({ ...ENV, BROWSERBASE_API_KEY: '' }), /BROWSERBASE_API_KEY/);
});

test('the agent\'s Chrome profile is owner-only, in the home and outside every run\'s work/; only the lease holder, or the first run, opens it', async (t) => {
  const { tmp, home } = await agentHome(t);
  const { run } = await started(home, 'run-1');
  const first = chromeProfileFor(home.dir, { runId: 'run-1', dir: run.dir }, { profiles: {}, leases: {} });
  assert.deepEqual(first, { dir: join(home.dir, 'chrome', CHROME_PROFILE), shared: true });
  assert.ok(relative(run.workspace, first.dir).startsWith('..'), 'the profile is not under work/');
  const known = { profiles: { [CHROME_PROFILE]: {} } };
  assert.equal(chromeProfileFor(home.dir, { runId: 'run-1', dir: run.dir }, { ...known, leases: { [CHROME_PROFILE]: { runId: 'run-1' } } }).shared, true);
  const other = chromeProfileFor(home.dir, { runId: 'run-1', dir: run.dir }, { ...known, leases: { [CHROME_PROFILE]: { runId: 'run-0' } } });
  assert.deepEqual(other, { dir: join(run.dir, 'chrome-profile'), shared: false }, 'another run holds the lease: a signed-out profile of the run\'s own');
  assert.ok(relative(run.workspace, other.dir).startsWith('..'));

  // A stand-in Chrome: it writes the port it "opened" into the profile, as Chrome does, and runs until it is stopped.
  const fake = join(tmp, 'fake-chrome.mjs');
  await writeFile(fake, `import { writeFileSync } from "node:fs";
const dir = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice(16);
writeFileSync(dir + "/args.json", JSON.stringify(process.argv.slice(2)));
writeFileSync(dir + "/DevToolsActivePort", "45123\\n/devtools/browser/fake\\n");
setInterval(() => {}, 1000);
`);
  const exe = join(tmp, 'chrome');
  await writeFile(exe, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  await chmod(exe, 0o755);
  const chrome = await startChrome(exe, first.dir);
  assert.equal(chrome.endpoint, 'http://127.0.0.1:45123');
  assert.equal((await stat(first.dir)).mode & 0o777, 0o700);
  const args = JSON.parse(await readFile(join(first.dir, 'args.json'), 'utf8'));
  for (const flag of ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${first.dir}`]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args, chromeArgs(first.dir));
  const prefs = JSON.parse(await readFile(join(first.dir, 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.session.restore_on_startup, 1, 'the profile keeps a site\'s session cookies across runs');
  await chrome.stop();
  assert.throws(() => process.kill(chrome.pid, 0), { code: 'ESRCH' }, 'stopped by its pid');
});

test('on a local Chrome without a live view: live.json says so, the root has no context id, and the shared profile goes back to the home', async (t) => {
  const { home } = await agentHome(t);
  const one = await started(home, 'run-1');
  const env = { ...CHROME_ENV, AGENT_CHROME_PROFILE: 'shared', AGENT_LIVE_VIEW_MODULE: pathToFileURL(join(one.run.dir, 'none.mjs')).href };
  const { options, browser } = await createAgent(one.where, env, { makeContext: async () => assert.fail('a local Chrome makes no Browserbase context') });
  const live = JSON.parse(await readFile(join(one.run.dir, 'live.json'), 'utf8'));
  assert.deepEqual([live.liveViewUrl, live.browser, live.note], [null, 'chrome', NO_LOCAL_VIEW]);
  assert.equal((await stat(join(one.run.dir, 'live.json'))).mode & 0o777, 0o600);
  const harness = await open(t, one.run, options);
  const root = await harness.root(ctx, options.root);
  assert.equal((await harness.snapshot(browser.docs.Config, root.id, ctx)).policy.contextId, null);
  await harness.close(ctx);
  await carryBack(home, one.run, { outcome: 'completed' });
  assert.deepEqual((await readAgentHome(home)).profiles[CHROME_PROFILE], { provider: 'chrome', ref: `chrome/${CHROME_PROFILE}`, state: 'ready' });
});

test('on a local Chrome with a live view: its viewer is mounted on a loopback port of the run, named in live-host.json, at /live/<run id> on the page\'s origin', async (t) => {
  const { home } = await agentHome(t);
  const one = await started(home, 'run-1');
  const module = join(one.run.dir, 'live-view.mjs');
  await writeFile(module, `export const made = [];
export function createLiveView(options) {
  made.push(options);
  const prefix = new URL(options.baseUrl).pathname + "/";
  return { handle(req, res) { if (!req.url.startsWith(prefix)) return false; res.end("viewer"); return true; }, upgrade() { return false; }, async close() { made.push("closed"); } };
}
export function liveViewProvider(provider) { return provider; }
`);
  const env = { ...CHROME_ENV, AGENT_LIVE_VIEW_MODULE: pathToFileURL(module).href };
  const { options } = await createAgent(one.where, env, { makeContext: async () => 'unused' });
  const { made } = await import(pathToFileURL(module).href);
  assert.deepEqual(made, [{ hostOrigin: 'http://127.0.0.1:8787', baseUrl: 'http://127.0.0.1:8787/live/run-1' }]);
  const { port } = JSON.parse(await readFile(join(one.run.dir, 'live-host.json'), 'utf8'));
  assert.equal((await stat(join(one.run.dir, 'live-host.json'))).mode & 0o777, 0o600);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/live/run-1/v/abc`)).text(), 'viewer');
  assert.equal((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status, 404);
  assert.equal(JSON.parse(await readFile(join(one.run.dir, 'live.json'), 'utf8')).note, undefined, 'a live view is coming: no note');
  const harness = await open(t, one.run, options);
  await options.wake({ harness, setStatus: async () => {} }, null);
  assert.equal(made.at(-1), 'closed', 'the viewer goes with the run');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/live/run-1/v/abc`));
});

test('a stop while the run\'s Chrome starts ends that Chrome by its pid, and the launcher exits', async (t) => {
  const { tmp, home } = await agentHome(t);
  const { run } = await started(home, 'run-1');
  // A stand-in Chrome that never opens its debugging port: the launcher is still waiting for it when it is stopped.
  const pidFile = join(tmp, 'chrome.pid');
  const fake = join(tmp, 'slow-chrome.mjs');
  await writeFile(fake, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.FAKE_PID_FILE, String(process.pid));\nsetInterval(() => {}, 1000);\n');
  const exe = join(tmp, 'chrome');
  await writeFile(exe, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  await chmod(exe, 0o755);
  const env = { ...process.env, AGENT_BROWSER: 'chrome', CHROME_PATH: exe, AGENT_MODEL_BASE_URL: 'http://127.0.0.1:9/v1', AGENT_MODEL: 'test-model', FAKE_PID_FILE: pidFile };
  const launcher = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, 'start-run.mjs'), run.dir], { env, stdio: 'ignore' });
  t.after(() => launcher.kill('SIGKILL'));
  for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const chrome = Number(await readFile(pidFile, 'utf8'));
  launcher.kill('SIGTERM');
  const ended = await new Promise((resolve) => launcher.once('exit', (code, signal) => resolve(code ?? signal)));
  assert.equal(ended, 1, 'the launcher exits on its own, after its cleanup');
  assert.throws(() => process.kill(chrome, 0), { code: 'ESRCH' }, 'the Chrome it was starting is gone');
});
