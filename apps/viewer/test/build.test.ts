// The static build: one classic script, the gallery (empty until a real run is recorded), and a page that opens from
// file:// and plays a recording (the test fixture, built into a page of its own), in a local Chrome when there is one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
// @ts-expect-error: the build script is plain JavaScript
import { build, checkModule } from '../build.mjs';
import * as drill from './restore-drill.ts';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const fixtures = new URL('fixtures/', import.meta.url).pathname;

test('the build is one classic script and the page, with a gallery of real recordings only: none yet', (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-build-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = build(out);
  assert.deepEqual(built.recordings, [], 'the hand-cut fixture is never bundled');
  const script = readFileSync(join(out, 'viewer.js'), 'utf8');
  new Script(script);
  assert.doesNotMatch(script, /^\s*(import|export)\s/m, 'no module syntax: a page from file:// cannot load modules');
  assert.equal(readFileSync(join(out, 'gallery.js'), 'utf8'), 'window.AGENTRUN_GALLERY = [];\n');
  assert.match(script, /No recordings yet\./);
});

test('a module imports names from the viewer\'s own modules only: no package, and no bare side-effect import', () => {
  assert.doesNotThrow(() => checkModule('panel.ts', "import { register } from './panels.ts';\nregister(x);"));
  assert.throws(() => checkModule('panel.ts', "import { render } from 'preact';"), /imports a package/);
  assert.throws(() => checkModule('app.ts', "import './workflow-map.ts';"), /imports \.\/workflow-map\.ts for its side effect alone/);
});

const noChrome = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` };

/** The page at `query`, as headless Chrome draws it from file://: its DOM, or its text. */
function pageHtml(dist: string, profile: string, query: string): string {
  const ran = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--virtual-time-budget=4000', '--dump-dom', `${pathToFileURL(join(dist, 'index.html')).href}?${query}`], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout;
}
const pageText = (dist: string, profile: string, query: string) => pageHtml(dist, profile, query).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replaceAll('&#39;', '\'');

test('the page opens from file:// and draws the recording: the counters and the labelled kill', noChrome, (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-file-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  build(join(out, 'dist'), fixtures);
  const text = pageText(join(out, 'dist'), join(out, 'profile'), 'r=reference-killed');
  for (const shown of ['paid calls made', 'repeated', 'processes', 'journal opens', 'killed: killed in the lead\'s request after the browser read', 'Model turns']) {
    assert.ok(text.includes(shown), `the page shows ${shown}`);
  }
  assert.match(text, /unknown cost/, 'the scripted judge reports no cost: unknown, never $0');
});

test('the page takes the manifest\'s chapters and baseline, marks a restore, and opens at a commit of a generation', noChrome, (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-file-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const recordings = join(out, 'recordings');
  cpSync(join(fixtures, 'reference-killed'), join(recordings, 'reference-killed'), { recursive: true });
  const killed = JSON.parse(readFileSync(join(recordings, 'reference-killed', 'manifest.json'), 'utf8'));
  writeFileSync(join(recordings, 'reference-killed', 'manifest.json'), JSON.stringify({ ...killed,
    chapters: [{ title: 'the first tool result', at: { gen: 2, commit: 28 } }], baseline: { recording: '../restore-drill', label: 'the restore drill' } }));
  mkdirSync(join(recordings, 'restore-drill', 'blobs'), { recursive: true });
  // A result that is a page: it must download, never open with the viewer's origin.
  const page = 'a'.repeat(64);
  writeFileSync(join(recordings, 'restore-drill', 'blobs', `${page}.html`), '<script>localStorage.setItem("x", "1")</script>');
  writeFileSync(join(recordings, 'restore-drill', 'manifest.json'), JSON.stringify({ ...drill.manifest, result: { blob: page, title: 'the report page' } }));
  writeFileSync(join(recordings, 'restore-drill', 'events.jsonl'), drill.lines.map((line) => JSON.stringify(line)).join('\n'));
  mkdirSync(join(recordings, 'live-only'));
  writeFileSync(join(recordings, 'live-only', 'manifest.json'), JSON.stringify({ ...drill.manifest, title: 'live lines only', generations: 1, kills: 0 }));
  writeFileSync(join(recordings, 'live-only', 'events.jsonl'), [
    { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 1, data: { gen: 1 } },
    { channel: 'live', source: 'browser', kind: 'launched', gen: 1, t: 10, seq: 1, data: { session: 's1' } },
    { channel: 'live', source: 'pi', kind: 'message_start', gen: 1, t: 20, seq: 2, conv: 1, data: { message: { role: 'assistant' } } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  build(join(out, 'dist'), recordings);

  const killedText = pageText(join(out, 'dist'), join(out, 'profile'), 'r=reference-killed');
  assert.ok(killedText.includes('the first tool result'), 'the manifest\'s chapter');
  assert.ok(!killedText.includes('process 1 starts'), 'in place of the derived chapters');
  assert.match(killedText, /Beside it, the restore drill, at its end: .*paid calls made/, 'the baseline\'s counters, from its own lines');
  assert.doesNotMatch(killedText, /breaks the format/);

  const resultLink = pageHtml(join(out, 'dist'), join(out, 'profile'), 'r=restore-drill').match(/<a [^>]*class="result"[^>]*>/)?.[0] ?? '';
  assert.match(resultLink, /download="a{64}"/, 'the HTML result downloads');
  assert.doesNotMatch(resultLink, /target=/, 'and never opens in a tab');
  const lost = pageText(join(out, 'dist'), join(out, 'profile'), 'r=restore-drill&at=1:5');
  assert.match(lost, /restored to commit 3: what came after it is a lost branch/);
  assert.match(lost, /after commit 5 of generation 1 · line 8 of 18/, 'commit 5 of the lost branch');
  assert.doesNotMatch(lost, /breaks the format/);
  const redo = pageText(join(out, 'dist'), join(out, 'profile'), 'r=restore-drill&at=2:5');
  // A recording with no durable line: nothing from the store is measured, and cost is unknown, never $0.
  const liveOnly = pageText(join(out, 'dist'), join(out, 'profile'), 'r=live-only');
  assert.match(liveOnly, /not measured paid calls made/);
  assert.match(liveOnly, /not measured model turns/);
  assert.match(liveOnly, /unknown cost/);
  assert.doesNotMatch(liveOnly, /\$0\.0000|0 paid calls made/);
  assert.match(liveOnly, /1 processes/, 'processes still come from the supervisor\'s lines');
  assert.match(redo, /after commit 5 of generation 2 · line 15 of 18/, 'commit 5 again, after the restore');
  const ended = pageText(join(out, 'dist'), join(out, 'profile'), 'r=restore-drill');
  assert.match(ended, /after commit 6 of generation 2 · line 18 of 18/, 'with no ?at=, the end');
});
