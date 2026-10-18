// The hosted gallery's workflow (.github/workflows/pages.yml): it publishes only from main, with the job's own token
// scoped to Pages and no secret, and only after its gate (scripts/recording/gate.mjs, tested on its own) passes on what
// the build made. The gate's step runs for real here, as written.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build as buildViewer } from '../apps/viewer/build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
/** The viewer built as the build step builds it (`build.mjs --files`): the recordings as files with their index. */
const build = (target, recordings) => buildViewer(target, recordings, { files: true });
const workflow = readFileSync(join(root, '.github/workflows/pages.yml'), 'utf8');
/** A top-level block of the workflow, its key line through the line before the next top-level key. */
const block = (key) => {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`${key}:`);
  assert.ok(start >= 0, `${key} is a top-level key`);
  const end = lines.findIndex((line, index) => index > start && /^[a-z]/.test(line));
  return lines.slice(start, end).filter((line) => line.trim() !== '').join('\n');
};
const GATE = 'node scripts/recording/gate.mjs apps/viewer/dist';

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
  const order = [at((line) => line === 'run: node apps/viewer/build.mjs --files'), at((line) => line === `run: ${GATE}`),
    at((line) => line.startsWith('uses: actions/upload-pages-artifact@')), at((line) => line.startsWith('uses: actions/deploy-pages@'))];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(workflow, /path: apps\/viewer\/dist\n/);
});

/** The gate's command run as the runner runs it (bash) in a directory laid out as the repository after the build step,
 *  with the gallery built from `recordings`; its exit code and output. */
const gate = (t, recordings) => {
  const dir = mkdtempSync(join(tmpdir(), 'pages-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts/recording'), { recursive: true });
  for (const name of ['gate.mjs', 'validate.mjs']) cpSync(join(root, 'scripts/recording', name), join(dir, 'scripts/recording', name));
  // Both import the one scanner, which lives in the reference example.
  mkdirSync(join(dir, 'examples/reference'), { recursive: true });
  cpSync(join(root, 'packages/reference/src/scan.ts'), join(dir, 'packages/reference/src/scan.ts'));
  // The report page is read with an HTML parser, from node_modules (the workflow installs it before the gate).
  cpSync(join(root, 'packages/reference/src/artifact.ts'), join(dir, 'packages/reference/src/artifact.ts'));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  build(join(dir, 'apps/viewer/dist'), recordings);
  return new Promise((resolve) => execFile('bash', ['-c', GATE], { cwd: dir }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
};

test('the gate, as the step runs it, passes the build of the bundled recordings and fails the step on a problem', async (t) => {
  const passed = await gate(t, join(root, 'apps/viewer/recordings'));
  assert.equal(passed.code, 0, passed.stderr);
  assert.match(passed.stdout, /apps\/viewer\/dist: 2 recording\(s\), every published file checked/);
  const copy = mkdtempSync(join(tmpdir(), 'pages-recordings-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(join(root, 'apps/viewer/recordings/reference-job'), join(copy, 'reference-job'), { recursive: true });
  writeFileSync(join(copy, 'reference-job', 'notes.txt'), `sk-${'a1'.repeat(20)}`);
  const refused = await gate(t, copy);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /recordings\/reference-job\/notes\.txt: contains a provider secret/);
});
