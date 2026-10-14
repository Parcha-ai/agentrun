// The static build: one classic script, the gallery (empty until a real run is recorded), and a page that opens from
// file:// and plays a recording (the test fixture, built into a page of its own), in a local Chrome when there is one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';

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

test('the page opens from file:// and draws the recording: the counters and the labelled kill', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-file-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  build(join(out, 'dist'), fixtures);
  const page = `${pathToFileURL(join(out, 'dist', 'index.html')).href}?r=reference-killed`;
  const ran = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(out, 'profile')}`,
    '--virtual-time-budget=4000', '--dump-dom', page], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(ran.status, 0, ran.stderr);
  const text = ran.stdout.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const shown of ['paid calls made', 'repeated', 'processes', 'journal opens', 'killed: killed in the lead\'s request after the browser read', 'Model turns']) {
    assert.ok(text.includes(shown), `the page shows ${shown}`);
  }
  assert.match(text, /unknown cost/, 'the scripted judge reports no cost: unknown, never $0');
});
