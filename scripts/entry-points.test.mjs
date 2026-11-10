// A script that runs only as the command decides so with isMain(import.meta) from scripts/is-main.mjs. Comparing
// process.argv[1] with the module's own URL fails when the path goes through a symlink (macOS's temp directory is one):
// Node resolves the module's URL, not argv[1], so the script exits 0 having done nothing. Reading import.meta.main
// directly fails where Node has none (20, 23, 24.0-24.1): it is undefined for the command too, with the same exit 0.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const self = 'scripts/entry-points.test.mjs';
// packages/pi-browser is a synced snapshot the harness owns. Its own engines include Node 24.0-24.1, which have no
// import.meta.main, so it uses the symlink-safe realpathSync form. It stays out of this scan for good.
const synced = 'packages/pi-browser/';

// A file that mentions process.argv[1] is red unless it is here, with the reason it is safe.
const childScript = 'reads argv[1] only inside the text of a child script (node -e or a written file), never as this module';
const label = 'reads argv[1] only as a label for the script being run, and never decides from it whether it is the command';
const realpathForm = 'compares realpathSync(argv[1]) with its URL, which is symlink-safe; the published package allows Node 23 and 24.0-24.1, which have no import.meta.main';
const reviewed = new Map([
  ['scripts/is-main.mjs', 'compares realpathSync(argv[1]) with its URL, symlink-safe, only where Node has no import.meta.main, to refuse the command rather than exit 0'],
  ['packages/computer/src/entry.ts', realpathForm],
  ['packages/pi-durable-disk/src/cli.ts', realpathForm],
  ['packages/pi-durable-agent/test/agent-store.test.mjs', childScript],
  ['packages/pi-durable-agent/test/serve-store.test.mjs', childScript],
  ['packages/pi-durable-agent/test/serve.test.mjs', childScript],
  ['packages/pi-durable-disk/test/commands.test.ts', childScript],
  ['packages/pi-durable-disk/test/place.test.ts', childScript],
  ['packages/pi/test/signin-entry.test.mjs', childScript],
  ['packages/serve/test/secret-custody.test.mjs', childScript],
  ['packages/serve/test/learn-support.mjs', childScript],
  ['packages/computer/test/phone-provider.test.mjs', childScript],
  ['spec/lean/sweep/capture-dsl.mjs', label],
  ['packages/serve/test/store-target.mjs', label],
]);

const suspect = (source) => source.includes('process.argv[1]');
const unreviewed = (sources) => sources.filter(([file, source]) => suspect(source) && !reviewed.has(file)).map(([file]) => file);
const tracked = () => execFileSync('git', ['ls-files', '*.mjs', '*.js', '*.ts', '*.mts', '*.cjs'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((file) => file && file !== self && !file.startsWith(synced))
  .map((file) => [file, readFileSync(new URL(file, root), 'utf8')]);

test('a file not on the list is red, whatever shape its comparison takes', () => {
  const split = "const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';\nif (import.meta.url === invoked) main();";
  assert.deepEqual(unreviewed([['examples/new-split.mjs', split]]), ['examples/new-split.mjs']);
  assert.deepEqual(unreviewed([['examples/new-filename.mjs', 'if (realpathSync(process.argv[1]) === import.meta.filename) main();']]), ['examples/new-filename.mjs']);
  const dirname = "const self = join(import.meta.dirname, 'run.mjs');\nif (process.argv[1] === self) main();";
  assert.deepEqual(unreviewed([['examples/new-dirname.mjs', dirname]]), ['examples/new-dirname.mjs']);
  assert.deepEqual(unreviewed([['scripts/new-cjs.cjs', 'if (process.argv[1] === __filename) main();']]), ['scripts/new-cjs.cjs']);
  assert.deepEqual(unreviewed([['packages/pi-durable-disk/src/cli.ts', split]]), [], 'a reviewed file passes');
  assert.deepEqual(unreviewed([['examples/main.mjs', 'if (isMain(import.meta)) main(process.argv[2]);']]), [], 'isMain(import.meta) passes');
  assert.deepEqual(unreviewed([['scripts/main.cjs', 'if (require.main === module) main();']]), [], 'require.main resolves symlinks and needs no entry');
});

test('no tracked script mentions process.argv[1] unless the site is reviewed', () => {
  assert.deepEqual(unreviewed(tracked()), [], 'use isMain(import.meta), or review the site and add it here with its reason');
});

test('every reviewed site still mentions process.argv[1]', () => {
  const sources = new Map(tracked());
  assert.deepEqual([...reviewed.keys()].filter((file) => !suspect(sources.get(file) ?? '')), [], 'drop the entries that no longer apply');
});

// A file that names import.meta.main is red unless it is here, with the reason it is safe: everything else asks isMain.
const copiedOut = 'an example: examples are copied standalone into consumer and scratch projects (the package check, test:examples), so none imports scripts/; a demo, not a check that could pass silently';
const ownPackage = "a package's test fixture or live script: it keeps to its own package, so it imports nothing from scripts/; driven by that package's tests, not a check that could pass silently";
const bare = new Map([
  ['scripts/is-main.mjs', 'reads it, and where Node has none refuses the command'],
  ['scripts/is-main.test.mjs', 'names it in comments and checks that this runtime sets it'],
  ['scripts/check-node.mjs', 'names it in a comment, on why it refuses Node 23 and 24.0-24.1'],
  ['examples/decision-demos/build.mjs', copiedOut],
  ['examples/research-eval.mjs', copiedOut],
  ['examples/research-live.mjs', copiedOut],
  ['examples/run-rank-candidates.mjs', copiedOut],
  ['examples/run-support-answer.mjs', copiedOut],
  ['packages/dsl/test/fixtures/graph/generate.mjs', ownPackage],
  ['packages/dsl/test/fixtures/graph/record.mjs', ownPackage],
  ['packages/pi-durable-agent/test/fixtures/serve-sample.mjs', ownPackage],
  ['packages/pi-durable-agent/test/fixtures/store-sample.mjs', ownPackage],
  ['packages/pi-durable-disk/test/fixtures/paid-api.ts', ownPackage],
  ['packages/serve/test/record-door-one-input.mjs', ownPackage],
]);
const readsMain = (source) => source.includes('import.meta.main');
const unasked = (sources) => sources.filter(([file, source]) => readsMain(source) && !bare.has(file)).map(([file]) => file);

test('a file that reads import.meta.main itself is red, whatever shape the read takes', () => {
  for (const source of ['if (import.meta.main) main();', 'import.meta.main && main();', 'if (!import.meta.main) process.exit(0);', 'const command = import.meta.main;']) {
    assert.deepEqual(unasked([['scripts/new.mjs', source]]), ['scripts/new.mjs'], source);
  }
  assert.deepEqual(unasked([['scripts/new.mjs', 'if (isMain(import.meta)) main();']]), [], 'isMain(import.meta) passes');
});

test('no tracked script reads import.meta.main unless the site is reviewed', () => {
  assert.deepEqual(unasked(tracked()), [], 'use isMain(import.meta) from scripts/is-main.mjs, or review the site and add it here with its reason');
});

test('every reviewed import.meta.main site still names it', () => {
  const sources = new Map(tracked());
  assert.deepEqual([...bare.keys()].filter((file) => !readsMain(sources.get(file) ?? '')), [], 'drop the entries that no longer apply');
});
