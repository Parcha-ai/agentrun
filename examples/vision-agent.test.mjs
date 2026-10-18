// The one vision agent at $0, on the reference host: a scripted lead over real files, for each example folder's question.
// It checks the plumbing a live run rests on (the question and files reach the agent, its code tool has the vision
// functions, the skills are in its instructions, the report it writes is kept in the recording with its cites by key)
// and that each example folder is a question, files with their sources and checks, and a README. Without ffmpeg and
// pdftoppm the runs skip.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exampleAt, fileName, inputOf, INSTRUCTIONS, skills } from './vision-agent/agent.ts';
import { argvFor, options } from './vision-agent/run.ts';
import { jevOptionsOf } from './vision-agent/live.ts';
import { demo } from '@parcha/agentrun-reference';

const PROGRAMS = (() => { try { for (const cmd of ['ffmpeg', 'ffprobe', 'pdftoppm']) execFileSync(cmd, [cmd === 'pdftoppm' ? '-v' : '-version'], { stdio: 'ignore' }); return false; } catch { return 'ffmpeg, ffprobe and pdftoppm are needed'; } })();
const EXAMPLES = ['video-chapters', 'hear-and-find', 'document-check'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratch = async (t) => { const tmp = await mkdtemp(join(tmpdir(), 'vision-agent-')); t.after(() => rm(tmp, { recursive: true, force: true })); return tmp; };
async function go(tmp, argv, env = {}) {
  Object.assign(process.env, env);
  try { return await demo({ ...options, argv: ['--dir', join(tmp, 'run'), ...argv] }); } finally { for (const name of Object.keys(env)) delete process.env[name]; }
}
const statusOf = (run) => run.processes.at(-1)?.outcome?.status;
const stderrOf = (run) => run.processes.map((process) => `${process.outcome?.message ?? ''}\n${process.stderr}`).join('\n');

test('each example is a question, its files with their sources and checks, and a README; nothing in it is code', () => {
  const assets = readFileSync(join(import.meta.dirname, '..', 'ASSETS.md'), 'utf8');
  for (const name of EXAMPLES) {
    const example = exampleAt(name);
    assert.ok(example.question.length > 40, `${name}: a question in plain words`);
    assert.ok(existsSync(join(example.dir, 'README.md')));
    assert.deepEqual(readdirSync(example.dir).filter((file) => /\.(m?[jt]s)$/.test(file)), [], `${name}: no code in the folder`);
    for (const item of example.items) {
      assert.match(item.sha256, /^[0-9a-f]{64}$/);
      assert.ok(item.bytes > 0 && (item.url || item.path), `${name}: ${item.id} is fetched or committed`);
      if (item.url) assert.match(item.url, /^https:\/\//);
      if (item.path) {
        const bytes = readFileSync(join(example.dir, item.path));
        assert.deepEqual([bytes.length, sha256(bytes)], [item.bytes, item.sha256], `${name}: ${item.path} is the file inputs.json checks`);
        assert.ok(assets.includes(`\`${fileName(item)}\``) && assets.includes(item.sha256), `${name}: ASSETS.md names ${fileName(item)} with its SHA-256`);
      }
    }
    assert.deepEqual(inputOf(example), { question: example.question, files: example.items.map(fileName), example: name });
  }
});

test('the agent\'s instructions carry the question\'s place, the functions, the citation rule, the report, and every skill the package ships', () => {
  const text = INSTRUCTIONS();
  for (const word of ['`question`', '`files`', 'vision.see', 'vision.judge', 'vision.transcribe', '#page=N', '#t=', 'report/']) assert.ok(text.includes(word), word);
  for (const skill of skills()) assert.ok(text.includes(`The ${skill.name} skill:`) && text.includes(skill.text.slice(0, 200)), skill.name);
  assert.ok(skills().some((skill) => skill.name === 'look') && skills().some((skill) => skill.name === 'find'));
  const [node] = options.job.workflow.root.steps;
  assert.deepEqual([node.tools, node.thinking], [['code'], 'medium'], 'one code tool, and the node thinks at medium');
  assert.deepEqual(options.spec.tools, [], 'no tool of the example\'s own');
});

test('Jev goes through the gateway\'s /typesafe when a gateway is set, else TYPESAFE_BASE_URL, else TypeSafe\'s own address', () => {
  const key = { TYPESAFE_API_KEY: 'placeholder' };
  assert.equal(jevOptionsOf({ ...key, VIDEO_MODEL_BASE_URL: 'https://gateway.invalid/v1', VIDEO_MODEL_API_KEY: 'placeholder' }).baseURL, 'https://gateway.invalid/typesafe');
  assert.equal(jevOptionsOf({ ...key, VIDEO_MODEL_BASE_URL: 'https://gateway.invalid/v1/' }).baseURL, 'https://gateway.invalid/typesafe');
  assert.equal(jevOptionsOf({ ...key, VIDEO_MODEL_BASE_URL: 'https://gateway.invalid/v1', TYPESAFE_BASE_URL: 'https://proxy.invalid' }).baseURL, 'https://gateway.invalid/typesafe', 'the gateway wins');
  assert.equal(jevOptionsOf({ ...key, TYPESAFE_BASE_URL: 'https://proxy.invalid' }).baseURL, 'https://proxy.invalid');
  assert.equal('baseURL' in jevOptionsOf(key), false, 'no gateway and no base: the SDK\'s own address');
  assert.equal(jevOptionsOf(key).apiKey, 'placeholder');
  assert.ok(options.spec.keys.some((entry) => entry.env === 'TYPESAFE_BASE_URL'), 'declared, so a live child gets it');
});

test('an example folder becomes the run\'s input', () => {
  const argv = argvFor(['examples/hear-and-find', '--live', '--record', 'r']);
  assert.deepEqual(argv.slice(0, 3), ['--live', '--record', 'r']);
  assert.deepEqual(JSON.parse(argv.at(-1)), inputOf(exampleAt('hear-and-find')));
  assert.deepEqual(argvFor(['--record', 'r']), ['--record', 'r'], 'no folder, nothing added');
});

test('on fakes the document check runs over the committed PDFs and ends with a report the recording keeps, its cite a look by key at #page=', { timeout: 300_000, skip: PROGRAMS }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const run = await go(tmp, ['--record', record, ...argvFor(['examples/document-check']).filter((arg, i, all) => i >= all.indexOf('--input'))], {});
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  assert.match(run.record.answer, /^\(scripted\)/);
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.kills, manifest.generations, manifest.example], [0, 1, 'document-check']);
  const kept = JSON.parse(readFileSync(join(record, 'blobs', `${manifest.result.blob}.json`), 'utf8'));
  assert.equal(kept.report.page, 'report/report.html');
  const page = readFileSync(join(record, 'blobs', `${kept.report.files['report.html']}.html`), 'utf8');
  assert.match(page, /<section id="answer">/);
  assert.ok(existsSync(join(record, 'blobs', `${kept.report.files['frames/one.png']}.png`)), 'the picture the report shows is a blob too');
  const [cite, ...more] = kept.rows[0].cites;
  assert.deepEqual(more, [], 'one cite, a look: the page itself is the result\'s report, not a cite');
  assert.deepEqual([cite.fragment, cite.note], ['#page=1', 'page 1']);
  const filed = readdirSync(join(tmp, 'run', 'evidence'), { recursive: true }).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(tmp, 'run', 'evidence', name), 'utf8')));
  assert.ok(filed.some((look) => look.facts.key === cite.look), 'the report\'s cite names a look the run filed');
});

test('on fakes a film question runs over a film given beside it, and the report cites the frame at #t=', { timeout: 300_000, skip: PROGRAMS }, async (t) => {
  const tmp = await scratch(t);
  const files = join(tmp, 'files');
  mkdirSync(files);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=160x120:rate=5', '-f', 'lavfi', '-i', 'sine=duration=4', '-shortest', '-pix_fmt', 'yuv420p', join(files, 'film.mp4')]);
  const input = { question: exampleAt('hear-and-find').question, files: ['film.mp4'] };
  const run = await go(tmp, ['--record', join(tmp, 'recording'), '--input', JSON.stringify(input)], { DEMO_FILES_DIR: files });
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  const manifest = JSON.parse(readFileSync(join(tmp, 'recording', 'manifest.json'), 'utf8'));
  const kept = JSON.parse(readFileSync(join(tmp, 'recording', 'blobs', `${manifest.result.blob}.json`), 'utf8'));
  assert.deepEqual(kept.rows[0].cites.map((cite) => [cite.fragment, cite.note]), [['#t=1', '1 s']]);
});
