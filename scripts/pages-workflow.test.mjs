// The hosted gallery's workflow (.github/workflows/pages.yml): it publishes only from main, with the job's own token
// scoped to Pages and no secret, and only after its gate passes on every bundled recording. The gate runs for real here,
// on the repository's recordings and on copies broken so it must refuse them.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(join(root, '.github/workflows/pages.yml'), 'utf8');
/** A top-level block of the workflow, its key line through the line before the next top-level key. */
const block = (key) => {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`${key}:`);
  assert.ok(start >= 0, `${key} is a top-level key`);
  const end = lines.findIndex((line, index) => index > start && /^[a-z]/.test(line));
  return lines.slice(start, end).filter((line) => line.trim() !== '').join('\n');
};
const GATE = 'node scripts/recording/validate.mjs apps/viewer/recordings/*/';

test('the workflow runs on a push to main that touches the viewer, or by hand, never on a pull request', () => {
  assert.equal(block('on'), ['on:', '  push:', '    branches: [main]', '    paths:', "      - 'apps/viewer/**'", "      - '.github/workflows/pages.yml'", '  workflow_dispatch:'].join('\n'));
});

test('its token reads the repository and writes Pages, and no secret is named', () => {
  assert.equal(block('permissions'), ['permissions:', '  contents: read', '  pages: write', '  id-token: write'].join('\n'));
  assert.equal(workflow.match(/permissions:/g).length, 1, 'no job widens it');
  assert.doesNotMatch(workflow, /secrets\./);
  assert.equal(block('concurrency'), ['concurrency:', '  group: pages', '  cancel-in-progress: false'].join('\n'));
});

test('the gate sits between the build and the upload, as the command run below and nothing more', () => {
  const lines = workflow.split('\n').map((line) => line.trim().replace(/^- /, ''));
  const at = (match) => {
    const index = lines.findIndex(match);
    assert.ok(index > 0, String(match));
    return index;
  };
  const order = [at((line) => line === 'run: node apps/viewer/build.mjs'), at((line) => line === `run: ${GATE}`),
    at((line) => line.startsWith('uses: actions/upload-pages-artifact@')), at((line) => line.startsWith('uses: actions/deploy-pages@'))];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(workflow, /path: apps\/viewer\/dist\n/);
});

/** The gate's command run in `cwd` as the runner runs it (bash), with its exit code and output. */
const gate = (cwd) => new Promise((resolve) => execFile('bash', ['-c', GATE], { cwd }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
/** A directory laid out as the repository, holding the validator and a copy of the bundled recordings. */
const copy = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pages-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts/recording'), { recursive: true });
  cpSync(join(root, 'scripts/recording/validate.mjs'), join(dir, 'scripts/recording/validate.mjs'));
  cpSync(join(root, 'apps/viewer/recordings'), join(dir, 'apps/viewer/recordings'), { recursive: true });
  return dir;
};

test('the gate passes the bundled recordings, each by name', async () => {
  const ran = await gate(root);
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stdout, /reference-job\/: a valid agentrun\.recording\/1 recording/);
  assert.match(ran.stdout, /ten-kills-seed21\/: a valid agentrun\.recording\/1 recording/);
});

test('the gate refuses a recording that holds a credential-shaped value, and a gallery with none', async (t) => {
  const dir = copy(t);
  const manifest = join(dir, 'apps/viewer/recordings/reference-job/manifest.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), title: `sk-${'a1'.repeat(20)}` }));
  const leaked = await gate(dir);
  assert.notEqual(leaked.code, 0);
  assert.match(leaked.stderr, /reference-job\/: manifest\.json contains a provider secret/);
  assert.match(leaked.stdout, /ten-kills-seed21\/: a valid/, 'the other recording is still checked and reported');
  const empty = copy(t);
  rmSync(join(empty, 'apps/viewer/recordings'), { recursive: true });
  mkdirSync(join(empty, 'apps/viewer/recordings'));
  assert.notEqual((await gate(empty)).code, 0, 'no recording to publish is a failure, never an empty gallery');
});
