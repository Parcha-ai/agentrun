// Hear and find, at $0, on the reference entry. What a run on fakes reads: the committed clip, three pieces of NASA's film,
// with no network. The scripted lead runs the transcribe and find skills' own programs in the code tool's sandbox; the
// scripted eyes, Jev and transcriber answer from clip/clip.json. The film's programs are needed: without ffmpeg every test
// that runs the job skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { scriptFor } from './hear-and-find/fakes.ts';
import { clipInput, FIND, TRANSCRIBE } from './hear-and-find/job.ts';
import { chooseModels, liveParts, transcriberOf } from './hear-and-find/models.ts';
import { options } from './hear-and-find/run.ts';
import { demo } from './reference/index.ts';

const FFMPEG = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return false; } catch { return 'ffmpeg and ffprobe are not installed'; } })();
const HERE = join(import.meta.dirname, 'hear-and-find');
const CLIP = JSON.parse(readFileSync(join(HERE, 'clip', 'clip.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratch = async (t) => { const tmp = await mkdtemp(join(tmpdir(), 'hear-and-find-')); t.after(() => rm(tmp, { recursive: true, force: true })); return tmp; };
async function go(tmp, args = []) { return demo({ ...options, argv: ['--dir', join(tmp, 'run'), ...args] }); }
const statusOf = (run) => run.processes.at(-1)?.outcome?.status;
const stderrOf = (run) => run.processes.map((process) => `${process.outcome?.message ?? ''}\n${process.stderr}`).join('\n');
const evidence = (tmp) => readdirSync(join(tmp, 'run', 'evidence'), { recursive: true }).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(tmp, 'run', 'evidence', name), 'utf8')));
const blocks = (text, lang) => [...text.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((match) => match[1]);

test('beat 1: on fakes, the agent hears the phrase both times and picks one, then finds the flag\'s second and box; the result cites the transcript, the Jev look and the frame', { timeout: 300_000, skip: FFMPEG }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const run = await go(tmp, ['--record', record]);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  const { rows, hear_and_find: found } = run.record;
  assert.deepEqual(found.heard.hits.map((hit) => hit.at), [4.7, 15.06], 'the phrase, both times it is said');
  assert.equal(found.heard.picked, 1);
  assert.match(found.heard.hits[1].before, /Contact light/, 'the rows around a hit go with it');
  assert.deepEqual(rows.map((row) => row.label), ['Heard, the landing call, during the descent: "Tranquility Base"', 'Also heard: "Tranquility Base"', 'Seen, the planted flag, first seen: a United States flag standing planted on the ground']);
  assert.deepEqual(rows.map((row) => row.value), ['0:15 (15.06 s)', '0:05 (4.7 s)', '0:28 (28 s)']);
  const filed = new Map(evidence(tmp).map((look) => [look.facts.key, look]));
  for (const row of rows.slice(0, 2)) {
    assert.equal(row.cites.length, 1, `${row.label} cites the transcript that heard it`);
    assert.equal(filed.get(row.cites[0].look)?.tool, 'transcribe');
  }
  assert.equal(found.seen.found, true);
  assert.equal(found.seen.at, CLIP.seen.from_s);
  found.seen.box.forEach((value, i) => assert.ok(Math.abs(value - CLIP.seen.box[i]) < 0.5, `the box ${found.seen.box} is clip.json's ${CLIP.seen.box}`));
  const [jev] = rows[2].cites;
  assert.equal(filed.get(jev.look)?.args.via, 'jev', 'the sighting cites the Jev look that checked its frame');
  assert.match(jev.fragment, /^#t=28&xywh=percent:/);
  // The recording's result is the same record with the frame and its box kept as a blob.
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  const kept = JSON.parse(readFileSync(join(record, 'blobs', `${manifest.result.blob}.json`), 'utf8'));
  const picture = kept.rows[2].cites[0];
  assert.ok(picture.blob && existsSync(join(record, 'blobs', `${picture.blob}.jpg`)), 'the frame with its box is a blob of the recording');
  assert.match(picture.fragment, /^#t=28&xywh=percent:/);
});

test('beat 2: the recording validates, says scripted, names the films it fetches, costs 0, and each transcript and judgment is filed once', { timeout: 300_000, skip: FFMPEG }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const run = await go(tmp, ['--record', record]);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  assert.deepEqual(validateRecording(record), []);
  const walk = (at) => (statSync(at).isDirectory() ? readdirSync(at).flatMap((name) => walk(join(at, name))) : [at]);
  assert.deepEqual(walk(record).filter((file) => /\.(?:jsonl?|txt|md)$/.test(file) && [hostname(), tmp].some((value) => readFileSync(file, 'utf8').includes(value))), [], 'no machine name or run directory in the recording');
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  assert.equal(manifest.providers, 'scripted');
  assert.deepEqual(manifest.models, { lead: 'scripted lead (pi-ai faux)', eyes: 'scripted-eyes', jev: 'scripted-jev', transcriber: 'scripted-words' });
  assert.deepEqual(manifest.sources.items.map((item) => item.sha256), JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8')).items.map((item) => item.sha256));
  assert.equal(manifest.cost.usd, 0, 'the scripted parts are priced at 0, so the run cost 0');
  const looks = evidence(tmp);
  const keys = looks.map((look) => look.facts.key);
  assert.equal(new Set(keys).size, keys.length, 'nothing asked twice');
  assert.equal(looks.filter((look) => look.tool === 'transcribe').length, 1, 'the clip is one piece of under ten minutes: one transcript');
  assert.equal(looks.filter((look) => look.args.via !== 'jev' && look.tool === 'look').length, 1, 'the eyes watched one window');
});

test('the scripted lead runs the skills\' own programs: every line of each is in its script but the ones the task sets', () => {
  const script = scriptFor({ film: clipInput.film, best: clipInput.best, phrase: clipInput.phrase, thing: clipInput.thing, box: clipInput.box, words: clipInput.words, budget_usd: clipInput.budget_usd });
  const [step1, step2, step4] = blocks(TRANSCRIBE, 'bash');
  assert.ok(script.includes(JSON.stringify(`VIDEO=${clipInput.film} CHUNK=600\n${step1}\n${step2}`)), 'the transcribe skill\'s steps 1 and 2, as one shell');
  assert.ok(script.includes(JSON.stringify(step4)), 'its step 4');
  const programs = [...blocks(TRANSCRIBE, 'js'), ...blocks(FIND, 'js')];
  assert.equal(programs.length, 7, 'the transcribe skill\'s step 3 and the find skill\'s six programs');
  for (const program of programs) {
    for (const line of program.split('\n').filter((each) => each.trim() && !/^const (task|video) = /.test(each))) {
      assert.ok(script.includes(line.replaceAll('.find/umbrella', '.find/the-united-states-flag')), `the script holds the skill's line: ${line}`);
    }
  }
});

test('what is asked is data: another phrase from the input is searched, and found once', { timeout: 300_000, skip: FFMPEG }, async (t) => {
  const tmp = await scratch(t);
  const run = await go(tmp, ['--input', JSON.stringify({ ...clipInput, phrase: 'Contact light', heard_question: 'the moment of touchdown' })]);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  assert.deepEqual(run.record.hear_and_find.heard.hits.map((hit) => hit.at), [10.4]);
  assert.equal(run.record.rows[0].label, 'Heard, the moment of touchdown: "Contact light"');
});

test('the clip: the committed file is the size and SHA-256 clip.json fixes, cut from the checked film, under 1 MB, with its sound, and the job\'s own file', { skip: FFMPEG }, () => {
  const bytes = readFileSync(join(HERE, 'clip', CLIP.file));
  assert.equal(bytes.length, CLIP.bytes);
  assert.equal(sha256(bytes), CLIP.sha256);
  assert.ok(bytes.length < 1_000_000);
  assert.deepEqual(readdirSync(join(HERE, 'clip')).sort(), [CLIP.file, 'clip.json', 'cut.sh'].sort());
  assert.equal(CLIP.from, JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8')).items[0].id);
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', join(HERE, 'clip', CLIP.file)], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  assert.deepEqual(streams, ['audio', 'video']);
  assert.deepEqual(new Uint8Array(options.job.files[CLIP.file]), new Uint8Array(bytes));
});

test('live models: the defaults, the transcriber through fal\'s own queue or a gateway\'s pass-through, and Jev\'s key asked for by name', () => {
  const name = ({ lead, eyes }) => [`${lead.provider}/${lead.modelId}`, `${eyes.provider}/${eyes.modelId}`];
  const gateway = { VIDEO_MODEL_BASE_URL: 'http://gateway.example/v1', VIDEO_MODEL_API_KEY: 'k' };
  assert.deepEqual(name(chooseModels(gateway)), ['openai/gpt-6-luna', 'google/gemini-3.8-flash']);
  assert.equal(transcriberOf({ FAL_KEY: 'k' }).model, 'fal-ai/elevenlabs/speech-to-text/scribe-v2');
  assert.equal(transcriberOf(gateway).provider, 'fal');
  assert.throws(() => transcriberOf({}), /FAL_KEY/);
  assert.throws(() => liveParts({ env: gateway, models: {} }), /TYPESAFE_API_KEY/);
  const parts = liveParts({ env: { ...gateway, TYPESAFE_API_KEY: 'k' }, models: {} });
  assert.deepEqual(Object.keys(parts.vision()).sort(), ['eyes', 'jev', 'transcriber']);
  assert.equal(parts.vision().eyes.accepts.video, true);
  assert.deepEqual(parts.models, { lead: 'openai/gpt-6-luna', eyes: 'google/gemini-3.8-flash', jev: 'typesafe/jev-1.14.0', transcriber: 'fal/fal-ai/elevenlabs/speech-to-text/scribe-v2' });
});
