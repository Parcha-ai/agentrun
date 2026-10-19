// The vision agent's result step reads the report page the agent's answer names only from under work/report/: a path
// that leaves report/, by its parts or through a link, is no report (the record says so), and nothing it names is read
// or kept. A page under report/ is read as before. The Answer schema refuses "." and ".." in the path. The run
// directories are built by the test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { workflow } from './vision-agent/agent.ts';
import { result } from './vision-agent/result.ts';

const INSIDE = 'a'.repeat(64);
const OUTSIDE = 'b'.repeat(64);
const page = (look, label) => `<html><body><section id="answer"><a class="cite" href="notice.pdf#page=1" data-look="${look}">${label}</a></section></body></html>`;

/** A run directory: work/report/index.html citing one look, and pages and a picture outside report/ citing another. */
function runDir(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'vision-agent-result-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'work', 'report', 'frames'), { recursive: true });
  writeFileSync(join(dir, 'work', 'report', 'index.html'), page(INSIDE, 'page 1'));
  writeFileSync(join(dir, 'work', 'report', 'frames', 'one.png'), 'a picture the report shows');
  writeFileSync(join(dir, 'work', 'x.html'), page(OUTSIDE, 'outside the report'));
  writeFileSync(join(dir, 'x.html'), page(OUTSIDE, 'outside the work'));
  mkdirSync(join(dir, 'elsewhere'));
  writeFileSync(join(dir, 'elsewhere', 'index.html'), page(OUTSIDE, 'through a link'));
  writeFileSync(join(dir, 'elsewhere', 'secret.txt'), 'not the report');
  const kept = [];
  const made = (report) => result({ answer: 'The reference number is 4471.', report }, { dir, keep: (bytes, extension) => { kept.push([Buffer.from(bytes).toString(), extension]); return `blob${kept.length}`; } });
  return { dir, kept, made };
}

test('a report path that leaves report/ is no report: the record says so, and nothing outside report/ is read or kept', async (t) => {
  for (const report of ['report/../x.html', 'report/./../../x.html', 'report/frames/../../x.html']) {
    const r = runDir(t);
    const { json } = await r.made(report);
    assert.equal(json.report, null, report);
    assert.deepEqual(json.rows[0].cites, [], `${report}: nothing of the page outside report/ is parsed`);
    assert.match(json.rows[0].note, /not a file under report\//, `${report}: the record says why there is no report`);
    assert.deepEqual(r.kept, [], `${report}: nothing is kept`);
    assert.doesNotMatch(JSON.stringify(json), new RegExp(OUTSIDE));
  }
});

test('a link out of report/ is no report either: report/ itself, a folder in it, the page, and a picture are not followed', async (t) => {
  const outside = (r) => join(r.dir, 'elsewhere');
  const cases = [
    ['report/ is a link', 'report/index.html', (r) => { rmSync(join(r.dir, 'work', 'report'), { recursive: true }); symlinkSync(outside(r), join(r.dir, 'work', 'report')); }],
    ['a folder in it is a link', 'report/out/index.html', (r) => symlinkSync(outside(r), join(r.dir, 'work', 'report', 'out'))],
    ['the page is a link', 'report/linked.html', (r) => symlinkSync(join(outside(r), 'index.html'), join(r.dir, 'work', 'report', 'linked.html'))],
  ];
  for (const [what, report, link] of cases) {
    const r = runDir(t);
    link(r);
    const { json } = await r.made(report);
    assert.equal(json.report, null, what);
    assert.deepEqual([json.rows[0].cites, r.kept], [[], []], `${what}: nothing read through the link`);
    assert.match(json.rows[0].note, /not a file under report\//, what);
  }
  // A picture in report/ that is a link out of it: the report is kept, without it.
  const r = runDir(t);
  symlinkSync(join(outside(r), 'secret.txt'), join(r.dir, 'work', 'report', 'frames', 'two.png'));
  const { json } = await r.made('report/index.html');
  assert.deepEqual(Object.keys(json.report.files).sort(), ['frames/one.png', 'index.html']);
  assert.ok(!r.kept.some(([text]) => text === 'not the report'), 'the linked file is not read');
});

test('a page under report/ is read as before, and a missing one is no report with nothing said', async (t) => {
  const r = runDir(t);
  const { json, title } = await r.made('report/index.html');
  assert.equal(title, 'The reference number is 4471.');
  const { report: { files, ...report }, ...rest } = json;
  assert.deepEqual(rest, {
    format: 'agentrun.cited/1', title: 'The reference number is 4471.',
    rows: [{ label: 'Answer', value: 'The reference number is 4471.', cites: [{ look: INSIDE, fragment: '#page=1', note: 'page 1' }] }],
  });
  assert.deepEqual(report, { page: 'report/index.html' });
  assert.deepEqual(Object.keys(files).sort(), ['frames/one.png', 'index.html'], 'every file under report/ is kept');
  assert.deepEqual(r.kept.map(([text]) => text).sort(), [page(INSIDE, 'page 1'), 'a picture the report shows'].sort());
  const missing = await runDir(t).made('report/none.html');
  assert.deepEqual(missing.json.rows[0], { label: 'Answer', value: 'The reference number is 4471.', cites: [] });
  assert.equal(missing.json.report, null);
});

test('the Answer schema takes a page under report/ and refuses a path with a "." or ".." part', () => {
  const pattern = new RegExp(workflow.schemas.Answer.properties.report.pattern);
  for (const ok of ['report/index.html', 'report/pages/page-2.html', 'report/a.b.html']) assert.match(ok, pattern, ok);
  for (const bad of ['report/../x.html', 'report/./index.html', 'report/./../../x.html', 'report/frames/../x.html', 'report//index.html', 'report/..html', 'report/.hidden.html', 'x/index.html']) assert.doesNotMatch(bad, pattern, bad);
});
