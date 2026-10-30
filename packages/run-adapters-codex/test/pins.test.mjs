// Codex is the host's install (a pinned devDependency here, an install the host makes elsewhere): the adapter checks the
// binary it would run against the pins, and refuses a mismatch with a typed error a host maps to the run's failure line.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { codexTarget, findCodex } from '../dist/binary.js';
import { localMachine } from '../dist/host/machine.js';
import { CODEX_ROUTES, gatewayHandler } from '../dist/host/process.js';
import { codexPins, verifyCodex, verifyCodexBinary } from '../dist/verify.js';
import { CODEX_BINARY_SHA256, CODEX_NPM_INTEGRITY, CODEX_VERSION, CodexNotInstalled, CodexPinMismatch } from '../dist/versions.js';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-pins-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
/** An executable that prints `output` when asked its version. */
function cli(name, output) {
  const path = join(ROOT, name);
  writeFileSync(path, `#!/bin/sh\necho "${output}"\n`);
  chmodSync(path, 0o755);
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}
const mismatch = (pin, expected, found) => (e) => e instanceof CodexPinMismatch && e.code === 'CODEX_PIN_MISMATCH' && e.pin === pin && e.expected === expected && e.found === found;
const notInstalled = (e) => e instanceof CodexNotInstalled && e.code === 'CODEX_NOT_INSTALLED';

test('the pin is Codex 0.164.0, with a binary sha256 for every target the lookup knows', () => {
  assert.equal(CODEX_VERSION, '0.164.0');
  for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
    const target = codexTarget(platform, arch);
    assert.match(CODEX_BINARY_SHA256[target.target] ?? '', /^[0-9a-f]{64}$/, target.target);
    assert.deepEqual(codexPins(target), { version: '0.164.0', sha256: CODEX_BINARY_SHA256[target.target], packageVersion: `0.164.0-${target.pkg}` });
  }
});

test("the repository's lockfile installs exactly the pinned launcher and platform packages (version and npm sha512)", () => {
  const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8')).packages;
  for (const [name, integrity] of Object.entries(CODEX_NPM_INTEGRITY)) {
    const entry = lock[`node_modules/${name}`];
    assert.ok(entry, `${name} is in the lockfile`);
    assert.equal(entry.version, name === '@openai/codex' ? CODEX_VERSION : `${CODEX_VERSION}-${name.slice('@openai/codex-'.length)}`, name);
    assert.equal(entry.integrity, integrity, name);
  }
});

test("a binary whose sha256 is not the pinned build's is refused, typed, with the pin, what was expected and what was found", () => {
  const other = cli('other', 'codex-cli 0.164.0');
  const result = verifyCodexBinary({ path: other.path }, { version: '0.164.0', sha256: 'f'.repeat(64) });
  assert.ok(mismatch('binary_sha256', 'f'.repeat(64), other.sha256)(result), String(result));
  assert.equal(result.path, other.path);
});

test('a binary that reports another version is refused, typed; the pinned one passes', () => {
  const newer = cli('newer', 'codex-cli 0.165.0');
  assert.ok(mismatch('version', '0.164.0', '0.165.0')(verifyCodexBinary({ path: newer.path }, { version: '0.164.0', sha256: newer.sha256 })));
  const odd = cli('odd', 'not codex');
  assert.ok(mismatch('version', '0.164.0', '"not codex"')(verifyCodexBinary({ path: odd.path }, { version: '0.164.0' })));
  const right = cli('right', 'codex-cli 0.164.0');
  assert.deepEqual(verifyCodexBinary({ path: right.path }, { version: '0.164.0', sha256: right.sha256 }), { path: right.path });
});

test("a platform package of another release is refused before the binary is read", () => {
  const right = cli('pkg', 'codex-cli 0.164.0');
  const result = verifyCodexBinary({ path: right.path, packageVersion: '0.165.0-linux-x64' }, { version: '0.164.0', sha256: right.sha256, packageVersion: '0.164.0-linux-x64' });
  assert.ok(mismatch('package_version', '0.164.0-linux-x64', '0.165.0-linux-x64')(result));
});

test("a relative CODEX_BIN is checked and run as one absolute path: the session starts it from its own empty directory", async () => {
  const right = cli('relative', 'codex-cli 0.164.0');
  // The host names it from its own working directory, where it is; the session's directory has no such file.
  const host = process.cwd();
  process.chdir(ROOT);
  let result;
  try {
    result = verifyCodexBinary({ path: './relative' }, { version: '0.164.0', sha256: right.sha256 });
  } finally {
    process.chdir(host);
  }
  const route = { routes: CODEX_ROUTES, models: { model: 'luna-test' }, credential: () => 'provider-secret', target: 'https://provider.invalid' };
  const acquire = localMachine({ dir: mkdtempSync(join(ROOT, 'session-')), proxy: { hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, tools: [] } });
  const machine = await acquire({ ctx: { runId: 'relative-bin' }, model: gatewayHandler(route) });
  try {
    const child = await machine.spawn({ command: result.path, args: ['--version'], env: { HOME: machine.dirs.home } });
    const lines = [];
    for await (const line of child.lines()) lines.push(line);
    await child.exited;
    assert.deepEqual(lines, ['codex-cli 0.164.0'], 'the checked binary runs from the session directory');
  } finally {
    await machine.close();
  }
  assert.equal(result.path, right.path);
});

test('no binary, a path with no file, or a file that cannot run is "not installed", typed, naming the install line', () => {
  for (const found of [undefined, { path: join(ROOT, 'missing') }]) {
    const result = verifyCodexBinary(found, { version: '0.164.0' });
    assert.ok(notInstalled(result), String(result));
    assert.match(result.message, /npm install --save-exact @openai\/codex@0\.164\.0/);
  }
  const notRunnable = join(ROOT, 'not-runnable');
  writeFileSync(notRunnable, 'data');
  assert.ok(notInstalled(verifyCodexBinary({ path: notRunnable }, { version: '0.164.0' })));
  assert.throws(() => verifyCodex({ path: join(ROOT, 'missing-too') }), notInstalled);
  assert.throws(() => verifyCodex({ path: cli('thrown', 'codex-cli 0.1.0').path }, { version: '0.164.0' }), mismatch('version', '0.164.0', '0.1.0'));
});

test("this machine's installed Codex is the pinned build: its package version, sha256 and reported version", { skip: !findCodex()?.packageVersion && 'no Codex platform package installed here' }, () => {
  const found = findCodex();
  assert.equal(found.packageVersion, `0.164.0-${codexTarget().pkg}`);
  assert.deepEqual(verifyCodex(found), { path: found.path });
});
