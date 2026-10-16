// A film, in chapters, at $0, on the reference entry. The template's three beats run what a run on fakes reads, the committed clip
// of NASA's film, with no network: the scripted lead's own script (ffprobe, windows cut with ffmpeg, `vision.see` on each, keyframes)
// runs in the code tool's sandbox, and the scripted eyes answer. Then the local server: a run started from the drop page's endpoint,
// followed as its recording grows, killed by its Kill endpoint mid-film, and resumed. The film's programs are needed: without
// ffmpeg every test here skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { clipInput } from './video-chapters/job.ts';
import { chooseModels, liveParts } from './video-chapters/models.ts';
import { options } from './video-chapters/run.ts';
import { serve } from './video-chapters/serve.ts';
import { demo } from './reference/index.ts';

const FFMPEG = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return false; } catch { return 'ffmpeg and ffprobe are not installed'; } })();
const CLIP = join(import.meta.dirname, 'video-chapters', 'clip');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const linesOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const scratch = async (t) => { const tmp = await mkdtemp(join(tmpdir(), 'video-chapters-')); t.after(() => rm(tmp, { recursive: true, force: true })); return tmp; };
/** `npm run demo:video-chapters -- <args>` in `<tmp>/run`, with the demo's `DEMO_*` settings in `env` for its processes. */
async function go(tmp, args = [], env = {}) {
  Object.assign(process.env, env);
  try { return await demo({ ...options, argv: ['--dir', join(tmp, 'run'), ...args] }); } finally { for (const name of Object.keys(env)) delete process.env[name]; }
}
const statusOf = (run) => run.processes.at(-1)?.outcome?.status;
const stderrOf = (run) => run.processes.map((process) => `${process.outcome?.message ?? ''}\n${process.stderr}`).join('\n');
/** The latest value of every `vision.looks` document: each look key's filings, in order. */
const looksOf = (record) => {
  const latest = new Map();
  for (const line of linesOf(join(record, 'events.jsonl'))) if (line.channel === 'durable' && line.data?.doc === 'vision.looks' && line.data.value) latest.set(line.data.key, line.data.value.looks);
  return latest;
};
const WINDOWS = clipInput.film && Math.ceil(JSON.parse(readFileSync(join(CLIP, 'clip.json'), 'utf8')).duration_s / clipInput.window_s);

test('beat 1: on fakes, with no network, the agent\'s own script cuts the clip into windows, looks at each with its sound, and the job delivers chapters as agentrun.cited/1, each citing its looks and a keyframe', { timeout: 240_000, skip: FFMPEG }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const run = await go(tmp, ['--record', record]);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  const cited = run.record;
  assert.equal(cited.format, 'agentrun.cited/1');
  assert.equal(cited.rows[0].label, 'Summary');
  assert.deepEqual(cited.video_chapters.dropped, []);
  assert.ok(cited.rows.length >= 2, 'a summary and at least one chapter');
  const filed = new Map(readdirSync(join(tmp, 'run', 'evidence'), { recursive: true }).filter((name) => name.endsWith('.json')).map((name) => {
    const look = JSON.parse(readFileSync(join(tmp, 'run', 'evidence', name), 'utf8'));
    return [look.facts.key, look];
  }));
  const seen = new Set();
  for (const row of cited.rows.slice(1)) {
    assert.match(row.value, /^\d+:\d\d to \d+:\d\d$/);
    for (const cite of row.cites) {
      const look = filed.get(cite.look);
      assert.ok(look, `the cite's look ${cite.look} is one the run filed`);
      assert.equal(look.facts.kind, 'video', 'the eyes saw the window as video, sound and all');
      assert.equal(cite.fragment, look.args.path.slice(look.args.path.indexOf('#')));
      seen.add(cite.fragment);
    }
  }
  assert.equal(seen.size, WINDOWS, 'every window of the clip is cited once');
  // The recording's result is the same record with each chapter's keyframe kept as a blob and cited at its second.
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  const kept = JSON.parse(readFileSync(join(record, 'blobs', `${manifest.result.blob}.json`), 'utf8'));
  for (const row of kept.rows.slice(1)) {
    const keyframe = row.cites.find((cite) => cite.note === 'keyframe');
    assert.ok(keyframe && existsSync(join(record, 'blobs', `${keyframe.blob}.jpg`)), `${row.label} cites its keyframe, kept as a blob`);
    assert.match(keyframe.fragment, /^#t=\d+$/);
  }
});

test('beat 2: killed inside the evidence sink at vision.filing, a fresh process runs the script again; the looks come back kept, the fold reads repeated 0 and unknown 0, each window paid once', { timeout: 300_000, skip: FFMPEG }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const [kill] = options.spec.kills;
  assert.ok(kill.n + kill.hold - 1 <= WINDOWS, 'the spec\'s kill lands inside the clip\'s looks');
  const run = await go(tmp, ['--kill', '--record', record]);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  assert.deepEqual(run.kills.map((each) => each.point), ['vision.filing']);
  assert.deepEqual(run.unlanded, []);
  assert.equal(run.processes.length, 2);
  const folded = fold(readEvents(record));
  assert.equal(folded.repeated, 0);
  assert.equal(folded.repeatedNotMeasured, 0);
  assert.equal(folded.unknown, 0);
  assert.equal(folded.paid.vision, WINDOWS, 'each window paid once');
  const looks = [...looksOf(record).values()];
  assert.equal(looks.length, WINDOWS, 'a window cut again is the same bytes, so its look is the same key');
  assert.ok(looks.some((filings) => filings.some((filing) => filing.record.facts.kept === true)), 'a look answered before the kill comes back kept');
});

test('beat 3: every look has its receipt, the recording validates, says scripted, names the film it fetches, and its cost is a number it earned', { timeout: 240_000, skip: FFMPEG }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const run = await go(tmp, ['--record', record]);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  assert.deepEqual(validateRecording(record), []);
  const walk = (at) => (statSync(at).isDirectory() ? readdirSync(at).flatMap((name) => walk(join(at, name))) : [at]);
  assert.deepEqual(walk(record).filter((file) => /\.(?:jsonl?|txt|md)$/.test(file) && [hostname(), tmp].some((value) => readFileSync(file, 'utf8').includes(value))), [], 'no machine name or run directory in the recording');
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  assert.equal(manifest.providers, 'scripted');
  assert.deepEqual(manifest.models, { lead: 'scripted lead (pi-ai faux)', eyes: 'scripted-eyes' });
  assert.equal(manifest.sources.items[0].sha256, JSON.parse(readFileSync(join(import.meta.dirname, 'video-chapters', 'sources.json'), 'utf8')).items[0].sha256);
  assert.equal(manifest.cost.usd, 0, 'the scripted parts are priced at 0, so the run cost 0');
  for (const filings of looksOf(record).values()) for (const filing of filings) assert.ok(filing.receipt && existsSync(join(tmp, 'run', filing.receipt)), 'each look\'s receipt is a file the run filed');
});

test('the clip: the committed file is the size and SHA-256 clip.json fixes, cut from the checked film, under 1 MB, with its sound, and the job\'s own file', { skip: FFMPEG }, () => {
  const clip = JSON.parse(readFileSync(join(CLIP, 'clip.json'), 'utf8'));
  const bytes = readFileSync(join(CLIP, clip.file));
  assert.equal(bytes.length, clip.bytes);
  assert.equal(sha256(bytes), clip.sha256);
  assert.ok(bytes.length < 1_000_000);
  assert.deepEqual(readdirSync(CLIP).sort(), [clip.file, 'clip.json', 'cut.sh'].sort());
  assert.equal(clip.from, JSON.parse(readFileSync(join(import.meta.dirname, 'video-chapters', 'sources.json'), 'utf8')).items[0].id);
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', join(CLIP, clip.file)], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  assert.deepEqual(streams, ['audio', 'video']);
  assert.deepEqual(new Uint8Array(options.job.files[clip.file]), new Uint8Array(bytes));
});

test('the server: a run started from the drop endpoint is followed as it grows, killed mid-film by its Kill endpoint, and resumed; it serves nothing outside a recording', { timeout: 300_000, skip: FFMPEG }, async (t) => {
  const tmp = await scratch(t);
  process.env.DEMO_EYES_DELAY_MS = '1200';
  t.after(() => { delete process.env.DEMO_EYES_DELAY_MS; });
  const served = await serve(options, ['--port', '0', '--runs', join(tmp, 'served')]);
  t.after(() => served.close());
  const at = (path, init) => fetch(`${served.url}${path}`, init);
  assert.equal((await at('/')).status, 200);
  assert.equal((await at('/viewer/')).status, 200);
  assert.equal((await at('/runs?name=notes.txt', { method: 'POST', body: 'x' })).status, 400, 'only a video is taken');
  const made = await (await at('/runs?source=clip', { method: 'POST' })).json();
  assert.equal(made.follow, `/viewer/index.html?follow=/runs/${made.id}/recording/`);
  const events = `/runs/${made.id}/recording/events.jsonl`;
  // Followed by Range from the last byte: whole lines only, until the first look is filed.
  let offset = 0;
  const read = [];
  for (let tries = 0; !read.some((line) => line.kind === 'LookEvent'); tries += 1) {
    assert.ok(tries < 200, 'a look is filed within a minute');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const response = await at(events, { headers: { range: `bytes=${offset}-` } });
    if (response.status === 416) continue;
    assert.equal(response.status, 206);
    const text = await response.text();
    assert.ok(text.endsWith('\n'), 'only whole lines');
    offset += Buffer.byteLength(text);
    read.push(...text.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  }
  assert.equal((await at(`/runs/${made.id}/recording/manifest.json`)).status, 404, 'no manifest while the run goes on');
  const killed = await (await at(`/runs/${made.id}/kill`, { method: 'POST' })).json();
  assert.equal(killed.gen, 1);
  let status;
  for (let tries = 0; ; tries += 1) {
    assert.ok(tries < 400, 'the run finishes');
    await new Promise((resolve) => setTimeout(resolve, 300));
    status = await (await at(`/runs/${made.id}/status`)).json();
    if (status.state !== 'running') break;
  }
  assert.equal(status.state, 'finished');
  assert.equal(status.processes, 2);
  assert.equal(status.kills, 1);
  const record = join(tmp, 'served', 'runs', made.id, 'recording');
  const folded = fold(readEvents(record));
  assert.equal(folded.repeated, 0);
  assert.equal(folded.paid.vision, WINDOWS);
  assert.ok([...looksOf(record).values()].some((filings) => filings.some((filing) => filing.record.facts.kept === true)), 'the look answered before the kill comes back kept');
  assert.equal((await at(`/runs/${made.id}/recording/manifest.json`)).status, 200);
  assert.equal((await at(`/runs/${made.id}/recording/..%2F..%2F..%2Frun.log`)).status, 404);
  assert.equal((await at(`/runs/${made.id}/kill`, { method: 'POST' })).status, 409, 'a finished run has no process to kill');
});

test('live models: the default lead and eyes, Google\'s eyes take a video window and the others take frames, and the live parts name the models for the manifest', () => {
  const name = ({ lead, eyes }) => [`${lead.provider}/${lead.modelId}`, `${eyes.provider}/${eyes.modelId}`];
  assert.deepEqual(name(chooseModels({ VIDEO_MODEL_BASE_URL: 'http://gateway/v1', VIDEO_MODEL_API_KEY: 'k' })), ['openai/gpt-6-luna', 'google/gemini-3.8-flash']);
  assert.deepEqual(name(chooseModels({ OPENAI_API_KEY: 'k' })), ['openai/gpt-6-luna', 'openai/gpt-6-sol']);
  assert.throws(() => chooseModels({}), /OPENAI_API_KEY/);
  const gateway = { VIDEO_MODEL_BASE_URL: 'http://gateway/v1', VIDEO_MODEL_API_KEY: 'k' };
  const google = liveParts({ env: gateway, models: {} });
  assert.equal(google.vision().eyes.accepts.video, true);
  assert.deepEqual(google.models, { lead: 'openai/gpt-6-luna', eyes: 'google/gemini-3.8-flash' });
  assert.equal(liveParts({ env: gateway, models: { eyesModel: 'openai/gpt-6-sol' } }).vision().eyes.accepts.video, false);
});
