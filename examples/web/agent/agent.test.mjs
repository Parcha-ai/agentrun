// The web example's agent app, offline: no network, no key, no model call. Runs are started in a real agent home with
// @parcha/pi-durable-agent, a run's Harness is opened on its store with the options the app returns, and its root
// conversation is created the way the serve door creates it, after the app's `beforeResume`.
import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { carryBack, readAgentHome, startRun } from '@parcha/pi-durable-agent';
import { browserOptions, createAgent, liveOf, NO_LOCAL_VIEW, PROFILE, promptOf, signInAsked, toolsOf } from './app.ts';
import { CHROME_PROFILE, chromeArgs, chromeProfileFor, startChrome } from './chrome.ts';
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

/** The app's options on the run's own store, `beforeResume` included, as pi-durable-disk opens a run. */
async function open(t, run, options) {
  const harness = await Harness.open(await openNodeSqliteStorage(run.storePath), { models: options.models, registry: options.registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx).catch(() => {}));
  await options.beforeResume({ harness, context: ctx });
  return harness;
}

test('the home is made from agent.json and the skills: the definition names no model, and the prompt carries each skill in order', async (t) => {
  const { tmp, home } = await agentHome(t);
  const state = await readAgentHome(home);
  assert.equal(state.identity.id, 'site-reporter');
  assert.deepEqual(Object.keys(state.skills).sort(), ['sign-in/SKILL.md', 'site-report/SKILL.md']);
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
