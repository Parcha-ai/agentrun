// The live view for a run's own Chrome, and the handoff port with it (packages/harness/src/live-view.ts): a plane with a
// port lists `browser_request_handoff`, and one without lists none; the port's files say what the person is asked, keep the
// viewer's URL in one owner-only file and nowhere else, and answer the wait from the person's outcome file or the deadline;
// a demo's process mounts it only for a local Chrome with LIVE_VIEW_DIR, and closes it when the process is done.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localHost, placeAt } from '@parcha/agentrun-harness';
import { compose } from '../packages/harness/dist/assemble.js';
import { mountLiveView } from '../packages/harness/dist/live-view.js';

// A umask that would let a group or others read a file the port creates without its own mode, so the mode checks below mean something.
process.umask(0o022);
const FIXTURE = new URL('./reference/demo-fixture.ts', import.meta.url);
const ID = '0b5e3f2a-6c1d-4e8f-9a7b-1c2d3e4f5a6b';
const VIEWER = 'http://127.0.0.1:1/live/v/abc#t=viewer-token-for-this-test';
const ask = (extra = {}) => ({ requestId: ID, sessionTag: 'browser-1', sessionId: 's-1', liveView: { fullscreen: VIEWER, framed: null, pages: [] }, instruction: 'Pick the option you want.', completionCondition: 'The dropdown shows your choice.', ...extra });
const signal = new AbortController().signal;

async function tmp(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function browserTools(t, plane) {
  const place = await placeAt(join(await tmp(t, 'reference-live-tools-'), 'run'));
  const { host } = localHost(place, { model: () => { throw new Error('unused'); }, tools: {}, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank' });
  if (plane) host.tools = { ...host.tools, browser: plane(host.tools.browser) };
  const job = { workflow: { v: 2, name: 'tools', schemas: {}, root: { node: 'chain', steps: [] } }, input: {} };
  const snapshot = (await compose(place, host, job)).registry.snapshot();
  return snapshot.tools().map(({ tool }) => tool.name).filter((name) => name.startsWith('browser_'));
}

test('a browser plane with a handoff port gives the agent browser_request_handoff; a plane without one does not', async (t) => {
  const port = { request: async () => ({ refused: 'unused' }), outcome: async () => 'pending' };
  const without = await browserTools(t);
  const withPort = await browserTools(t, (browser) => ({ ...browser, handoff: port }));
  assert.ok(without.length > 0, 'the browser offers its tools');
  assert.ok(!without.includes('browser_request_handoff'), 'no port, no handoff tool');
  assert.deepEqual(withPort.filter((name) => !without.includes(name)), ['browser_request_handoff'], 'the port adds the handoff tool and nothing else');
});

test("the port writes the request without the viewer's URL, the URL alone in a 0600 file, and waits until the person's outcome file says done", async (t) => {
  const dir = await tmp(t, 'reference-live-port-');
  const view = await mountLiveView({ dir });
  t.after(() => view.close());
  assert.deepEqual(await view.handoff.request(ask(), signal), { interactionId: ID });
  const files = join(dir, 'handoff');
  assert.equal(statSync(files).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(files).sort(), [`${ID}.json`, `${ID}.viewer`]);
  const request = JSON.parse(readFileSync(join(files, `${ID}.json`), 'utf8'));
  assert.deepEqual([request.instruction, request.completionCondition, request.sessionTag], ['Pick the option you want.', 'The dropdown shows your choice.', 'browser-1']);
  assert.ok(!readFileSync(join(files, `${ID}.json`), 'utf8').includes('viewer-token'), 'the request file carries no token');
  assert.equal(readFileSync(join(files, `${ID}.viewer`), 'utf8'), `${VIEWER}\n`);
  assert.equal(statSync(join(files, `${ID}.viewer`)).mode & 0o777, 0o600, 'the viewer URL is owner-only');
  assert.equal(await view.handoff.outcome(ID, signal), 'pending');
  writeFileSync(join(files, `${ID}.outcome`), 'done\n');
  assert.equal(await view.handoff.outcome(ID, signal), 'done');
  writeFileSync(join(files, `${ID}.outcome`), 'cancelled');
  assert.equal(await view.handoff.outcome(ID, signal), 'cancelled');
  writeFileSync(join(files, `${ID}.outcome`), 'maybe');
  assert.equal(await view.handoff.outcome(ID, signal), 'pending', 'anything but done or cancelled is no answer');
});

test('the same request asked again keeps its file and deadline and writes the viewer URL the live view has now; past the deadline it ends expired; a session with no live view is refused', async (t) => {
  const dir = await tmp(t, 'reference-live-again-');
  const view = await mountLiveView({ dir, expiresMs: 300 });
  t.after(() => view.close());
  await view.handoff.request(ask(), signal);
  const file = join(dir, 'handoff', `${ID}.json`);
  const first = readFileSync(file, 'utf8');
  const later = 'http://127.0.0.1:1/live/v/def#t=a-newer-token';
  assert.deepEqual(await view.handoff.request(ask({ liveView: { fullscreen: later, framed: null, pages: [] } }), signal), { interactionId: ID });
  assert.equal(readFileSync(file, 'utf8'), first, 'the request and its deadline are kept');
  assert.equal(readFileSync(join(dir, 'handoff', `${ID}.viewer`), 'utf8'), `${later}\n`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(await view.handoff.outcome(ID, signal), 'expired');
  assert.deepEqual(await view.handoff.request(ask({ requestId: '1b5e3f2a-6c1d-4e8f-9a7b-1c2d3e4f5a6b', liveView: null }), signal), { refused: 'this browser session has no live view' });
  await assert.rejects(view.handoff.outcome('../../etc/passwd', signal), /not a handoff id/, 'an id is never a path');
});

test("a demo's process mounts the live view only for a local Chrome with LIVE_VIEW_DIR, gives the plane the port, and closes it when it is done", { timeout: 60_000 }, async (t) => {
  const dir = await tmp(t, 'reference-live-child-');
  const spec = join(dir, 'demo.json');
  writeFileSync(spec, JSON.stringify({ name: 'reference' }));
  process.env.DEMO_SPEC = spec;
  const { options } = await import(FIXTURE.href);
  const { prepareChild } = await import('../packages/harness/dist/demo.js');
  const place = (name) => ({ id: 'reference', root: join(dir, name), work: join(dir, name, 'work'), store: join(dir, name, 'store') });
  const cases = [
    ['chrome with LIVE_VIEW_DIR', { BROWSER: 'chrome', LIVE_VIEW_DIR: join(dir, 'live') }, true],
    ['chrome without it', { BROWSER: 'chrome' }, false],
    ['the fake browser with it', { LIVE_VIEW_DIR: join(dir, 'live-fake') }, false],
  ];
  for (const [name, env, mounted] of cases) {
    const prepared = await prepareChild(options, { ...env, BACKEND: 'http://127.0.0.1:1' }, place(name.replaceAll(' ', '-')));
    assert.equal(prepared.host.tools.browser.handoff !== undefined, mounted, name);
    assert.equal(existsSync(join(env.LIVE_VIEW_DIR ?? join(dir, 'none'), 'handoff')), mounted, `${name}: the handoff directory`);
    await prepared.done();
  }
  // The live view's server holds the process open until done() closes it: this test ending at all is that check.
});
