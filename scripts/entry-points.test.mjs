// A script that runs only as the command decides so with import.meta.main. Comparing process.argv[1] with the module's
// own URL fails when the path goes through a symlink (macOS's temp directory is one): Node resolves the module's URL,
// not argv[1], so the script exits 0 having done nothing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const ownUrl = String.raw`(?:fileURLToPath\(import\.meta\.url\)|import\.meta\.(?:url|filename))`;
const argvCheck = new RegExp(String.raw`process\.argv\[1\][^;\n]{0,40}===\s*${ownUrl}|${ownUrl}\s*===[^;\n]{0,40}process\.argv\[1\]|===\s*(?:pathToFileURL|new URL)\([^;\n]{0,40}process\.argv\[1\]`);

test('the argv[1] check is recognised in each form the repository has used', () => {
  for (const line of [
    "if (process.argv[1] === fileURLToPath(import.meta.url)) build();",
    "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();",
    "if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();",
    "if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {",
    "if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {",
    "if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {",
    "const isMain = () => realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);",
    "export function isMain(url) { return !!process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href; }",
  ]) assert.match(line, argvCheck, line);
  for (const line of [
    'if (import.meta.main) await main();',
    "spawn(process.execPath, ['-e', 'f(process.argv[1])', file], { cwd: new URL('..', import.meta.url).pathname });",
  ]) assert.doesNotMatch(line, argvCheck, line);
});

test('no tracked script compares process.argv[1] with its own URL to decide it is the command', () => {
  const files = execFileSync('git', ['ls-files', '*.mjs', '*.js', '*.ts', '*.mts', '*.cjs'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const self = 'scripts/entry-points.test.mjs';
  const found = files.filter((file) => file !== self).flatMap((file) => readFileSync(new URL(file, root), 'utf8').split('\n')
    .flatMap((line, at) => argvCheck.test(line) ? [`${file}:${at + 1}`] : []));
  assert.deepEqual(found, [], 'use import.meta.main');
});
