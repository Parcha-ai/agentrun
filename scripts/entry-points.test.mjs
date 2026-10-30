// A script that runs only as the command decides so with import.meta.main. Comparing process.argv[1] with the module's
// own URL fails when the path goes through a symlink (macOS's temp directory is one): Node resolves the module's URL,
// not argv[1], so the script exits 0 having done nothing.
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
  ['packages/pi-durable-disk/src/cli.ts', realpathForm],
  ['packages/pi-durable-disk/src/hosts/daytona-launch.ts', realpathForm],
  ['packages/pi-durable-disk/src/hosts/local-host.ts', childScript],
  ['examples/reference-demo-providers.test.mjs', childScript],
  ['examples/web/server.test.mjs', childScript],
  ['examples/reference-demo-recording.test.mjs', childScript],
  ['examples/reference-demo-supervision.test.mjs', childScript],
  ['examples/reference-record.test.mjs', childScript],
  ['packages/pi-durable-agent/test/agent-store.test.mjs', childScript],
  ['packages/pi-durable-agent/test/serve-store.test.mjs', childScript],
  ['packages/pi-durable-agent/test/serve.test.mjs', childScript],
  ['packages/pi-durable-disk/test/commands.test.ts', childScript],
  ['packages/pi-durable-disk/test/live/_p9.ts', childScript],
  ['packages/pi-durable-disk/test/live/daytona-probe.ts', childScript],
  ['packages/pi-durable-disk/test/live/docker-probe.ts', childScript],
  ['packages/pi-transport/src/testing/move-conformance.ts', childScript],
  ['packages/pi-vision/test/durable-providers.test.mjs', childScript],
  ['packages/pi-vision/test/node-env.test.mjs', childScript],
  ['packages/pi/test/signin-entry.test.mjs', childScript],
  ['packages/serve/test/secret-custody.test.mjs', childScript],
  ['spec/lean/sweep/capture-dsl.mjs', label],
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
  assert.deepEqual(unreviewed([['examples/main.mjs', 'if (import.meta.main) main(process.argv[2]);']]), [], 'import.meta.main passes');
  assert.deepEqual(unreviewed([['scripts/main.cjs', 'if (require.main === module) main();']]), [], 'require.main resolves symlinks and needs no entry');
});

test('no tracked script mentions process.argv[1] unless the site is reviewed', () => {
  assert.deepEqual(unreviewed(tracked()), [], 'use import.meta.main, or review the site and add it here with its reason');
});

test('every reviewed site still mentions process.argv[1]', () => {
  const sources = new Map(tracked());
  assert.deepEqual([...reviewed.keys()].filter((file) => !suspect(sources.get(file) ?? '')), [], 'drop the entries that no longer apply');
});
