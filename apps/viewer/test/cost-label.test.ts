// The cost on the strip names a scripted run (its manifest's `providers`): its zero reads "scripted, $0", never
// "$0.0000", because what fakes and scripts report is not a provider's bill.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { costLabel } from '../src/counters.ts';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

test('a scripted run says so, and its zero is $0', () => {
  assert.equal(costLabel(0, false, 'scripted'), 'scripted, $0');
  assert.equal(costLabel(0.0036, false, 'scripted'), 'scripted, $0.0036', 'a price its fakes report');
  assert.equal(costLabel(0, true, 'scripted'), 'at least scripted, $0');
});

test('a real run, or one whose manifest does not say, reads in dollars to four places; unknown is unknown', () => {
  assert.equal(costLabel(0.0125, false, 'real'), '$0.0125');
  assert.equal(costLabel(0, false, 'real'), '$0.0000');
  assert.equal(costLabel(0.5, false), '$0.5000');
  assert.equal(costLabel(null, false, 'scripted'), 'unknown');
  assert.equal(costLabel(null, true), 'unknown');
});

test('on the page, a bundled scripted run reads scripted, $0 and says its providers', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-cost-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  build(join(out, 'dist'));
  const ran = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(out, 'profile')}`,
    '--virtual-time-budget=4000', '--dump-dom', `${pathToFileURL(join(out, 'dist', 'index.html')).href}?r=reference-job`], { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(ran.error);
  assert.equal(ran.status, 0, ran.stderr);
  const text = ran.stdout.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /scripted, \$0 cost/);
  assert.doesNotMatch(text, /\$0\.0000/);
  assert.match(text, / · scripted providers · /);
});
