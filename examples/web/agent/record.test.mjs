// The web example's recording, offline: a run of the agent app on fakes (a faux model, pi-browser's fake backend and
// driver, a fake DevTools endpoint for the frames), opened the way pi-durable-disk opens a run, recorded into RECORD_DIR
// and finished the way start-run.mjs finishes it. No network, no key, no model call.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { startRun } from '@parcha/pi-durable-agent';
import { localRun, openDurableRun } from '@parcha/pi-durable-disk';
import { FakeBackend, fakeDriver, fixturePage, makeSentinels } from '@parcha/pi-browser/testing';
import { fakeCdp, jpeg as fakeJpeg } from '../../../packages/pi-browser/test/fixtures/fake-cdp.mjs';
import { validateRecording } from '../../../scripts/recording/validate.mjs';
import { createAgent } from './app.ts';
import { ensureAgentHome } from './home.mjs';
import { writeReplay } from '../replay.mjs';
import { finishRunRecording } from './record.ts';
import { REDACTED, sessionLabel } from './redact.ts';

const SECURE = 'https://the-internet.herokuapp.com/secure';
const MODEL = { AGENT_MODEL_BASE_URL: 'http://127.0.0.1:9/v1', AGENT_MODEL: 'test-model' };
const CHROME = { ...MODEL, AGENT_BROWSER: 'chrome', AGENT_CHROME_ENDPOINT: 'http://127.0.0.1:9', AGENT_CHROME_PROFILE: 'shared' };
/** The practice site's shared account, which its login page prints: words the person types, so the recording holds neither. */
const ACCOUNT = ['tomsmith', 'SuperSecretPassword!'];
const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Secure area</title><style>:root { color-scheme: light dark; }</style></head><body><h1>Secure area</h1><p>The run started signed in: the secure page says so.</p><p><a href="https://the-internet.herokuapp.com/secure">the-internet.herokuapp.com/secure</a></p></body></html>\n';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what) => { for (const end = Date.now() + 5_000; !check(); await sleep(20)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); };
/** A picture ffmpeg can decode, so the frames export as a WebM; a JPEG-shaped buffer where there is no ffmpeg. */
const picture = (n) => (HAVE_FFMPEG ? execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${(0x203040 + n * 0x101010).toString(16)}:s=320x200`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']) : fakeJpeg(320, 200, 10, n));
const filesUnder = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));
const linesOf = (dir) => readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const liveViews = (value, found = []) => {
  if (Array.isArray(value)) value.forEach((inner) => liveViews(inner, found));
  else if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) (key === 'liveView' ? found.push(inner) : liveViews(inner, found));
  return found;
};

/**
 * One run as the take's run 2 makes it: the agent reads the secure page, writes report/index.html, report.md and
 * pages.csv, releases the browser and answers. `plant` commits a session row with a live view into the run's
 * `browser.sessions`, as a host that kept a whole SessionRow would, and has the answer name a URL with a token. Without
 * `record` the run has no RECORD_DIR, and its store is left as the run left it.
 */
async function recordedRun(t, { env: base, plant = false, record = true }) {
  const tmp = await mkdtemp(join(tmpdir(), 'web-record-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const home = await ensureAgentHome(join(tmp, 'home'));
  const run = await startRun(home, { runId: 'run-1', host: 'test' });
  const where = { ref: { disk: 'local', region: 'local', id: 'run-1' }, root: run.dir, work: run.workspace, store: join(run.dir, 'store') };
  const dir = join(tmp, 'recording');
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  const sentinels = { ...makeSentinels(), bbConnectUrl: `${cdp.url}?sessionId=none` };
  const backend = new FakeBackend({ sentinels, start: SECURE, pages: { [SECURE]: fixturePage(SECURE, `Secure Area. Welcome to the Secure Area. Signed in as ${ACCOUNT[0]}; the login page said to use ${ACCOUNT[1]}.`, 'The Internet') } });
  const contextId = randomUUID();
  const env = { ...base, ...(record ? { RECORD_DIR: dir, RECORD_REDACT: JSON.stringify(ACCOUNT) } : {}), ...(base.AGENT_BROWSER === 'chrome' ? {} : { BROWSERBASE_API_KEY: sentinels.bbApiKey }) };
  const agent = await createAgent(where, env, { makeContext: async () => contextId, provider: backend.provider, driver: fakeDriver(backend) });
  const framesFile = join(run.dir, 'frames', 'frames.jsonl');
  const kept = () => (existsSync(framesFile) ? readFileSync(framesFile, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  const planted = `https://live.example.test/inspector?token=${randomUUID()}`;
  const faux = fauxProvider({ models: [{ id: 'scripted' }] });
  faux.setResponses([
    fauxAssistantMessage([fauxThinking('The browser may already be signed in: read the secure page first.'), fauxToolCall('browser_read', {}, { id: 'read' })], { stopReason: 'toolUse' }),
    async () => {
      // The page as the browser showed it while the agent read it, two frames apart.
      await until(() => cdp.screencasts().length === 1, 'the screencast');
      for (const n of [1, 2]) {
        cdp.frame({ bytes: picture(n) });
        await until(() => kept() === n, `frame ${n}`);
        await sleep(600);
      }
      return fauxAssistantMessage([fauxToolCall('write', { path: 'report/index.html', content: PAGE }, { id: 'page' })], { stopReason: 'toolUse' });
    },
    fauxAssistantMessage([fauxToolCall('write', { path: 'report.md', content: '# Secure area\n\nThe run started signed in.\n' }, { id: 'md' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('write', { path: 'pages.csv', content: `order,url,title\n1,${SECURE},The Internet\n` }, { id: 'csv' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('browser_release', {}, { id: 'release' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText(`Wrote report.md and pages.csv.${plant ? ` A viewer once showed ${planted} here.` : ''}`)], { stopReason: 'stop' }),
  ]);
  agent.options.models.setProvider(faux.provider);
  const durable = await openDurableRun(where.ref, { ...localRun(run.dir), harness: { models: agent.options.models, registry: agent.options.registry }, beforeResume: agent.options.beforeResume });
  const root = await durable.harness.root(ctx, { ...agent.options.root, agent: { ...agent.options.root.agent, model: { provider: faux.provider.id, modelId: 'scripted' } } });
  assert.equal((await (await root.submit({ type: 'input', content: 'Report what the practice site shows behind its login.', requestId: 'job' }, ctx)).wait(ctx)).status, 'done');
  // A row with a session id the provider never gave this process: only the finish, from the store, can know to take it out.
  const plantedSession = randomUUID();
  if (plant) await durable.harness.commit(async (tx) => { const state = await tx.doc(agent.browser.docs.Sessions, root.id); state.sessions.push({ ...state.sessions[0], tag: 'ar-run-1-1-9', resourceId: plantedSession, liveView: { fullscreen: planted, framed: null, pages: [] } }); }, ctx);
  // The run is let go as the server lets it go: its wake releases the browser and stops the recording, then the claim.
  await agent.options.wake(durable, null);
  await durable.release();
  const sessions = backend.ledger.filter((row) => row.op === 'create').map((row) => row.id);
  const values = { contextId, sessions, plantedSession, liveView: sentinels.bbLiveViewUrl, liveToken: sentinels.bbLiveViewToken, planted, key: sentinels.bbApiKey, connect: sentinels.bbConnectUrl };
  if (!record) return { tmp, run, values };
  // What the run wrote itself, its spool included, already holds none of the ids it learned: they were learned where they arose.
  assertAbsent(dir, { 'the profile id': base.AGENT_BROWSER === 'chrome' ? 'chrome/local-chrome' : contextId, 'the key': env.BROWSERBASE_API_KEY, ...Object.fromEntries(sessions.map((id, n) => [`session ${n + 1}`, id])) });
  const finished = await finishRunRecording({ dir, run: run.dir, env, providers: 'scripted' });
  return { tmp, dir, run, finished, values };
}

/** Every file of the recording (lines, manifest, every blob) holds none of `secrets`, raw or as a JSON string writes it. */
function assertAbsent(dir, secrets) {
  for (const file of filesUnder(dir)) {
    const bytes = readFileSync(file);
    for (const [name, value] of Object.entries(secrets)) if (value && (bytes.includes(value) || bytes.includes(JSON.stringify(value).slice(1, -1)))) assert.fail(`${name} is in ${file.slice(dir.length + 1)}`);
  }
}

test('a recorded run on the agent\'s own Chrome: valid, its report the artifact, the profile document kept with its id redacted, and no id, live view or token in any file', { timeout: 60_000 }, async (t) => {
  const { dir, run, finished, values } = await recordedRun(t, { env: CHROME });
  assert.deepEqual(validateRecording(dir), []);
  const lines = linesOf(dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.title, manifest.task, manifest.model, manifest.generations, manifest.kills, manifest.providers], ['Site reporter', 'Report what the practice site shows behind its login.', 'test-model', 1, 0, 'scripted']);
  assert.deepEqual([manifest.artifact.title, manifest.artifact.entry, Object.keys(manifest.artifact.files)], ['What I remember', 'remember.html', ['index.html', 'remember.html']]);
  const remembered = readFileSync(join(dir, 'blobs', `${manifest.artifact.files['remember.html']}.html`), 'utf8');
  assert.match(remembered, /<h1>What I remember<\/h1>[\s\S]*<a href="index\.html">/, 'the host\'s page is the entry, and links to the report the agent wrote');
  assert.equal(readFileSync(join(dir, 'blobs', `${manifest.artifact.files['index.html']}.html`), 'utf8'), PAGE);

  // What the chat view reads: pi's durable messages and its live message and tool events.
  const kinds = new Set(lines.map((line) => line.kind));
  for (const kind of ['pi.user', 'pi.assistant', 'pi.tool-result', 'message_start', 'message_end', 'tool_execution_start', 'tool_execution_end']) assert.ok(kinds.has(kind), `a ${kind} line`);
  assert.equal(lines.filter((line) => line.source === 'host' && line.kind === 'process.started').length, 1);

  // No durable line is dropped: the profile is there, with its id redacted and everything else as it was.
  const profiles = lines.filter((line) => line.kind === 'browser.profiles');
  assert.ok(profiles.length >= 1, 'the browser.profiles lines are kept');
  assert.deepEqual(profiles.at(-1).data.value, { provider: 'chrome', ref: REDACTED, state: 'ready' });

  // The frames, each under its session's label; a WebM of them where ffmpeg is installed.
  const [session] = values.sessions;
  const frames = lines.filter((line) => line.kind === 'frame');
  assert.equal(frames.length, 2);
  assert.ok(frames.every((line) => line.data.session === sessionLabel(session)));
  assert.equal(finished.frames, 2);
  if (HAVE_FFMPEG) {
    const [track] = lines.filter((line) => line.kind === 'frame.track');
    assert.equal(track.data.session, sessionLabel(session));
    assert.ok(existsSync(join(dir, 'blobs', `${track.blobs[0]}.webm`)) && existsSync(join(dir, 'blobs', `${track.blobs[1]}.json`)));
  }

  assert.deepEqual(liveViews(lines), [], 'no line holds a live view');
  assertAbsent(dir, { 'the account name': ACCOUNT[0], 'the account password': ACCOUNT[1], 'the profile id': 'chrome/local-chrome', ...Object.fromEntries(values.sessions.map((id, n) => [`session ${n + 1}`, id])), 'the live view': values.liveView, 'its token': values.liveToken, 'the planted token': values.planted.split('token=')[1], 'the connect URL': values.connect });
  assert.ok(!existsSync(join(dir, '.spool')), 'the spool is gone');

  const out = process.env.RECORDING_OUT;
  if (out) {
    // Kept for the take's scan step (scan-take.mjs): the recording and the run's store.
    await cp(dir, join(out, 'recording'), { recursive: true });
    await cp(join(run.dir, 'store', 'run.sqlite'), join(out, 'run.sqlite'));
  }
});

test('a recorded run on Browserbase: the context id and the key are redacted everywhere, and a session row a host committed with its live view is recorded with liveView null', { timeout: 60_000 }, async (t) => {
  const { dir, values } = await recordedRun(t, { env: MODEL, plant: true });
  assert.deepEqual(validateRecording(dir), []);
  const lines = linesOf(dir);
  const sessions = lines.filter((line) => line.kind === 'browser.sessions');
  const planted = sessions.at(-1).data.value.sessions.find((row) => 'liveView' in row);
  assert.deepEqual([planted?.resourceId, planted?.liveView], [sessionLabel(values.plantedSession), null], 'the planted row is recorded, its id a label and its live view null');
  assert.ok(liveViews(lines).every((view) => view === null));
  assert.ok(lines.some((line) => line.kind === 'pi.assistant' && JSON.stringify(line).includes(`token=${REDACTED}`)), 'the answer\'s token is redacted where it stood');
  const config = lines.filter((line) => line.kind === 'browser.config').at(-1);
  assert.equal(config.data.value.policy.contextId, REDACTED);
  assert.deepEqual(lines.filter((line) => line.kind === 'browser.profiles').at(-1).data.value, { provider: 'browserbase', ref: REDACTED, state: 'ready' });
  assertAbsent(dir, { 'the context id': values.contextId, 'the key': values.key, ...Object.fromEntries(values.sessions.map((id, n) => [`session ${n + 1}`, id])), 'the live view': values.liveView, 'its token': values.liveToken, 'the planted live view': values.planted, 'the planted token': values.planted.split('token=')[1], 'the planted session': values.plantedSession, 'the connect URL': values.connect });
});

test('a replay of a run takes out what the recording does: no session id, token or live view in timeline.json or any file, each session under its label', { timeout: 60_000 }, async (t) => {
  // A run on its own Chrome profile holds no saved sign-in, so its store is one a replay takes as it is.
  const { tmp, run, values } = await recordedRun(t, { env: { ...CHROME, AGENT_CHROME_PROFILE: 'own' }, plant: true, record: false });
  const out = join(tmp, 'replay');
  await writeReplay(out, [{ id: 'run-1', store: join(run.dir, 'store', 'run.sqlite'), files: run.workspace }, { id: 'given', rows: [{ kind: 'tool_result', liveView: { fullscreen: values.planted } }], files: { 'view.json': JSON.stringify({ url: values.planted }) } }]);
  assertAbsent(out, { ...Object.fromEntries([...values.sessions, values.plantedSession].map((id, n) => [`session ${n + 1}`, id])), 'the planted live view': values.planted, 'the planted token': values.planted.split('token=')[1], 'the live view': values.liveView, 'its token': values.liveToken });
  const timeline = readFileSync(join(out, 'runs', 'run-1', 'timeline.json'), 'utf8');
  assert.ok(timeline.includes(sessionLabel(values.sessions[0])), 'browser_release\'s session id is its label');
  assert.ok(timeline.includes(`token=${REDACTED}`), 'the answer\'s token is redacted where it stood');
  assert.deepEqual(liveViews(JSON.parse(readFileSync(join(out, 'runs', 'given', 'timeline.json'), 'utf8'))), [null], 'a row\'s live view is null');
  assert.equal(JSON.parse(readFileSync(join(out, 'runs', 'given', 'files', 'view.json'), 'utf8')).url, `https://live.example.test/inspector?token=${REDACTED}`);
});
