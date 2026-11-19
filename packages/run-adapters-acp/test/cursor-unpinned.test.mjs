// Cursor's tests on a host Cursor is not pinned for. CURSOR_PIN pins linux-x86_64 alone, so on any other host (a Mac
// among them) Cursor's adapter is refused ACP_BINARY_UNPINNED before it reads a file of Cursor's. The files whose tests
// reach the adapter run again here, in a process whose process.arch says arm64 (linux-aarch64: no pin, the rest of this
// host as it is), and must pass, the adapter's test by asserting that refusal by its code, never by a skip.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Loaded before the tests: this process says it runs on arm64, so acpPlatform() is linux-aarch64, which no pin names. */
const AS_ARM64 = 'data:text/javascript,Object.defineProperty(process,"arch",{value:"arm64"})';
const FILES = ['cursor-recipe.test.mjs', 'cursor-key-walk.test.mjs'].map((file) => fileURLToPath(new URL(`./${file}`, import.meta.url)));

test('on a host Cursor is not pinned for (linux-aarch64, faked), its tests pass, the adapter refused ACP_BINARY_UNPINNED by its code', { timeout: 180_000 }, () => {
  const env = { ...process.env };
  for (const name of ['AGENTRUN_TEST_CURSOR', 'AGENTRUN_TEST_CURSOR_LIVE', 'CURSOR_API_KEY', 'NODE_TEST_CONTEXT']) delete env[name];
  const run = spawnSync(process.execPath, ['--import', AS_ARM64, '--test', '--test-reporter=tap', ...FILES], { encoding: 'utf8', env });
  const lines = run.stdout.split('\n');
  assert.deepEqual(lines.filter((line) => /^\s*not ok/.test(line)), [], run.stdout.slice(-4000));
  assert.equal(run.status, 0, run.stderr.slice(-2000));
  const adapter = lines.find((line) => /^ok \d+ - Cursor's adapter/.test(line));
  assert.ok(adapter && /ACP_BINARY_UNPINNED/.test(adapter) && !/# SKIP/.test(adapter), `the adapter's test ran, by the refusal: ${adapter}`);
});
