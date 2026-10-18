// A Delaware certified copy, checked mark by mark, at $0, on the reference entry: the scripted lead runs the verify skill's
// two steps as written in the `code` tool's sandbox (pdftoppm renders the pages, ffmpeg cuts the file numbers out), the
// scripted Jev answers from sample/sample.json, and the job delivers agentrun.cited/1 with the PDF kept as a blob. The
// filed pages have every mark; the TEST COPY has none. Without pdftoppm, ffmpeg and ffprobe every run here skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { stepFor } from './document-check/fakes.ts';
import { citedOf } from './document-check/tools.ts';
import { options } from './document-check/run.ts';
import { demo } from './reference/index.ts';

const PROGRAMS = (() => { try { for (const cmd of ['pdftoppm', 'ffmpeg', 'ffprobe']) execFileSync(cmd, ['-v'], { stdio: 'ignore' }); return false; } catch (error) { return error.code === 'ENOENT' ? 'pdftoppm, ffmpeg or ffprobe is not installed' : false; } })();
const HERE = join(import.meta.dirname, 'document-check');
const sample = JSON.parse(readFileSync(join(HERE, 'sample', 'sample.json'), 'utf8'));
const checklist = JSON.parse(readFileSync(join(HERE, 'checklist', 'delaware-certified-copy.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratch = async (t) => { const tmp = await mkdtemp(join(tmpdir(), 'document-check-')); t.after(() => rm(tmp, { recursive: true, force: true })); return tmp; };
const go = (tmp, args = []) => demo({ ...options, argv: ['--dir', join(tmp, 'run'), ...args] });
const statusOf = (run) => run.processes.at(-1)?.outcome?.status;
const stderrOf = (run) => run.processes.map((process) => `${process.outcome?.message ?? ''}\n${process.stderr}`).join('\n');
/** A mark's place in sample.json as the cited format writes it: percent of the page, to the thousandth. */
const placeOf = (page, id) => {
  const [l, t, r, b] = sample.marks[page][id];
  const { width, height } = sample.size;
  const at = (v) => Math.floor(v * 1000) / 1000;
  return [at((l / width) * 100), at((t / height) * 100), at(((r - l) / width) * 100), at(((b - t) / height) * 100)];
};
const xywh = (fragment) => fragment.split('xywh=percent:')[1].split(',').map(Number);
/** The result as the recording keeps it: the blob the result line names. */
const recorded = (record) => {
  const line = readFileSync(join(record, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((each) => JSON.parse(each)).findLast((each) => each.kind === 'result');
  return JSON.parse(readFileSync(join(record, 'blobs', `${line.data.blob}.json`), 'utf8'));
};
const near = (got, want, what) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 0.01, `${what}: ${got} is not ${want}`));

test('the sample: each committed PDF is the file sample.json names by SHA-256, and the filed one holds the four EDGAR page images byte for byte', () => {
  const filed = readFileSync(join(HERE, 'sample', sample.files.filed));
  const images = [];
  for (let at = filed.indexOf('/DCTDecode'); at >= 0; at = filed.indexOf('/DCTDecode', at + 1)) {
    const length = Number(/\/Length (\d+)/.exec(filed.subarray(at, at + 80).toString('latin1'))[1]);
    const start = filed.indexOf('stream\n', at) + 'stream\n'.length;
    images.push(sha256(filed.subarray(start, start + length)));
  }
  assert.deepEqual(images, sample.pages.map((page) => page.sha256));
  for (const [name, file] of Object.entries(sample.files)) assert.equal(sha256(readFileSync(join(HERE, 'sample', file))), sample.sha256[name], file);
  assert.match(sample.files.test_copy, /TEST-COPY-marks-removed\.pdf$/, 'the altered copy says so in its name');
  assert.ok(existsSync(join(HERE, 'sample', sample.files.test_copy)));
});

test('the scripted lead runs the verify skill\'s two steps with only the task line set', () => {
  const skill = readFileSync(join(import.meta.dirname, '..', 'packages', 'pi-vision', 'skills', 'verify', 'SKILL.md'), 'utf8');
  const steps = [...skill.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);
  const state = { document: sample.files.filed, checklist: 'delaware-certified-copy.json' };
  for (const n of [0, 1]) {
    const code = stepFor(n, state);
    assert.equal(code.split('\n').slice(1).join('\n'), steps[n].split('\n').slice(1).join('\n'));
    assert.equal(code.split('\n')[0], `const task = { document: "${state.document}", checklist: "${state.checklist}" };`);
  }
});

test('on fakes, the filed pages: every mark yes, each boxed on its page, the PDF kept as a blob every cite names', { timeout: 240_000, skip: PROGRAMS }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const run = await go(tmp, ['--record', record]);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  const cited = run.record;
  assert.equal(cited.format, 'agentrun.cited/1');
  assert.equal(cited.title, `${sample.files.filed}: 6 of 6 marks there`);
  assert.deepEqual(cited.rows.map((row) => [row.id, row.label, row.value]), checklist.marks.map((mark) => [mark.id, mark.mark, 'yes']));
  assert.deepEqual(cited.document_check.marks.map((mark) => mark.id), checklist.marks.map((mark) => mark.id));
  const blob = sha256(readFileSync(join(HERE, 'sample', sample.files.filed)));
  for (const row of recorded(record).rows) for (const cite of row.cites) {
    assert.equal(cite.blob, blob);
    assert.match(cite.look, /^[0-9a-f]{64}$/, `${row.label}: a look backs the place`);
  }
  const rows = Object.fromEntries(cited.rows.map((row) => [row.id, row]));
  for (const id of ['seal', 'signature', 'file_number', 'authentication']) {
    assert.match(rows[id].cites[0].fragment, /^page=1&xywh=percent:/);
    near(xywh(rows[id].cites[0].fragment), placeOf('1', id), id);
  }
  near(xywh(rows.filed_stamp.cites[0].fragment), placeOf('3', 'filed_stamp'), 'filed_stamp');
  assert.deepEqual(rows.numbers_match.cites.map((cite) => cite.fragment), [rows.file_number.cites[0].fragment, rows.filed_stamp.cites[0].fragment]);
  assert.deepEqual(validateRecording(record), []);
  assert.ok(existsSync(join(record, 'blobs', `${blob}.pdf`)), 'the recording keeps the PDF');
});

test('on fakes, the TEST COPY: every mark no, each row citing only the page it was looked for on', { timeout: 240_000, skip: PROGRAMS }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const run = await go(tmp, ['--input', 'test-copy', '--record', record]);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  const cited = run.record;
  assert.equal(cited.title, `${sample.files.test_copy}: 0 of 6 marks there`);
  assert.deepEqual(cited.rows.map((row) => row.value), checklist.marks.map(() => 'no'));
  assert.deepEqual(cited.rows.map((row) => row.cites.map((cite) => cite.fragment)), [['page=1'], ['page=1'], ['page=1'], ['page=1'], ['page=3'], ['page=1', 'page=3']]);
  assert.equal(cited.rows.at(-1).note, 'file_number and filed_stamp not there');
  const blob = sha256(readFileSync(join(HERE, 'sample', sample.files.test_copy)));
  assert.ok(recorded(record).rows.flatMap((row) => row.cites).every((cite) => cite.blob === blob), 'the cites name the TEST COPY');
});

test('cite builds the rows step 2 wrote, in the checklist\'s order, whatever the lead submitted, and lists what it submitted otherwise', async (t) => {
  const tmp = await scratch(t);
  const folder = join(tmp, 'work', '.verify', 'a_b.pdf');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(tmp, 'work', 'list.json'), JSON.stringify({ marks: [{ id: 'seal' }, { id: 'stamp' }] }));
  const written = [
    { id: 'stamp', mark: 'The stamp', value: 'no', p: 0.1, note: 'not there', cites: [{ fragment: 'a b.pdf#page=2', receipts: [] }] },
    { id: 'seal', mark: 'The seal', value: 'yes', p: 0.9, note: 'round', cites: [{ fragment: 'a b.pdf#page=1&xywh=percent:1,2,3,4', receipts: ['evidence/none.json'] }] },
  ];
  writeFileSync(join(folder, 'marks.json'), JSON.stringify({ document: 'a b.pdf', rows: written }));
  const submitted = [{ ...written[1] }, { ...written[0], value: 'yes' }, { id: 'table', mark: 'Table of marks', value: 'no', p: 0, note: '', cites: [] }];
  const cited = citedOf(tmp, { document: 'a b.pdf', checklist: 'list.json', every: true, rows: submitted });
  assert.deepEqual(cited.rows.map((row) => [row.id, row.label, row.value]), [['seal', 'The seal', 'yes'], ['stamp', 'The stamp', 'no']]);
  assert.equal(cited.title, 'a b.pdf: 1 of 2 marks there');
  assert.equal(cited.document_check.every, false);
  assert.deepEqual(cited.document_check.differences, ['the lead submitted stamp: yes, which step 2 did not write', 'the lead submitted table: no, which step 2 did not write']);
  assert.deepEqual(cited.rows[0].cites, [{ fragment: 'page=1&xywh=percent:1,2,3,4', note: 'no look this run filed backs this place' }], 'a receipt that is no look the run filed backs nothing');
});
