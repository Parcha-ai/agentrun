import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { npmExecutableMode } from './npm-executable-mode.mjs';

const exec = promisify(execFile);

test('npm executable permissions include the regular-file baseline before both masks, without special bits', () => {
  for (const [npmMask, systemMask, expected] of [
    [0, 0o022, 0o755], [0, 0o002, 0o775], [0o022, 0o002, 0o755],
    [0, 0o027, 0o750], [0o777, 0o022, 0o600],
  ]) assert.equal(npmExecutableMode(npmMask, systemMask), expected);
  for (const invalid of [-1, 0o1000, 0.5, NaN, '22', undefined]) {
    assert.throws(() => npmExecutableMode(invalid, 0o022), /file-creation mask/);
    assert.throws(() => npmExecutableMode(0, invalid), /file-creation mask/);
  }
});

test('a real offline npm install of a 0755 embedded executable follows the two masks', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-npm-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'agentrun-mode-fixture', version: '1.0.0', files: ['dist'] }));
  const original = join(source, 'dist/daemon');
  await writeFile(original, '#!/bin/sh\nprintf "daemon-fixture"\n');
  await chmod(original, 0o755);
  const userconfig = join(root, 'user.npmrc'), globalconfig = join(root, 'global.npmrc');
  await writeFile(userconfig, ''); await writeFile(globalconfig, '');
  const config = ['--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    `--userconfig=${userconfig}`, `--globalconfig=${globalconfig}`, `--cache=${join(root, 'cache')}`];
  const npmCommand = process.env.npm_execpath ? process.execPath : 'npm';
  const prefix = process.env.npm_execpath ? [process.env.npm_execpath] : [];
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|NODE_OPTIONS|NODE_PATH)/i.test(key)));
  const runNpm = async (args, cwd, systemMask) => exec(process.execPath, ['--input-type=module', '-e', `
    import { spawnSync } from 'node:child_process';
    process.umask(Number(process.env.AGENTRUN_MODE_TEST_MASK));
    const child = spawnSync(process.env.AGENTRUN_MODE_TEST_COMMAND, JSON.parse(process.env.AGENTRUN_MODE_TEST_ARGS), { stdio: 'inherit' });
    if (child.error) throw child.error;
    process.exit(child.status ?? 1);
  `], { cwd, env: { ...env, AGENTRUN_MODE_TEST_MASK: String(systemMask),
    AGENTRUN_MODE_TEST_COMMAND: npmCommand, AGENTRUN_MODE_TEST_ARGS: JSON.stringify([...prefix, ...args, ...config]) },
    timeout: 30_000, maxBuffer: 1024 * 1024 });
  const [packed] = JSON.parse((await runNpm(['pack', '--json', '--pack-destination', root], source, 0o022)).stdout);
  const tarball = join(root, packed.filename);
  const listing = (await exec('tar', ['-tvzf', tarball])).stdout;
  assert.match(listing, /^-rwxr-xr-x\s.+ package\/dist\/daemon$/m, 'the archive remains exactly 0755');
  for (const [systemMask, npmMask, expected] of [[0o022, 0, 0o755], [0o002, 0, 0o775], [0o002, 0o022, 0o755], [0o027, 0, 0o750], [0o022, 0o777, 0o600]]) {
    const consumer = join(root, `consumer-${systemMask}-${npmMask}`);
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), '{"private":true}');
    await runNpm(['install', '--package-lock=false', `--umask=0o${npmMask.toString(8)}`, tarball], consumer, systemMask);
    const installed = join(consumer, 'node_modules/agentrun-mode-fixture/dist/daemon');
    assert.equal((await stat(installed)).mode & 0o7777, expected, 'actual npm behavior agrees with the independently chosen mode');
    assert.equal((await stat(installed)).mode & 0o7777, npmExecutableMode(npmMask, systemMask));
    assert.equal(await readFile(installed, 'utf8'), await readFile(original, 'utf8'));
    if (expected & 0o100) assert.equal((await exec(installed)).stdout, 'daemon-fixture');
  }
});
