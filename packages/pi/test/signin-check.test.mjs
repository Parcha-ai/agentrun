// checkKeys and checkSetupPrompt: what a demo needs, checked before anything starts, and its setup prompt against its
// spec. Neither sends a request: the global fetch fails the test if anything calls it.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { checkKeys, checkSetupPrompt } from '@parcha/agentrun-pi/signin';

const root = mkdtempSync(join(tmpdir(), 'agentrun-signin-check-'));
after(() => rmSync(root, { recursive: true, force: true }));
const realFetch = globalThis.fetch;
let requests = 0;
beforeEach(() => { requests = 0; globalThis.fetch = async () => { requests += 1; throw new Error('the key check sent a request'); }; });
afterEach(() => { globalThis.fetch = realFetch; });

/** A directory holding one executable `name` that runs `body` with /bin/sh. */
function bin(name, body) {
  const dir = mkdtempSync(join(root, 'bin-'));
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
  return dir;
}

const SPEC = {
  name: 'demo',
  models: { lead: { needs: ['text', 'tools'] } },
  keys: [
    { env: 'DEMO_API_KEY', why: 'the demo service', where: 'https://example.test/keys', required: true, for: 'live' },
    { env: 'DEMO_REGION', why: 'its region; us-east when unset', where: 'the console', required: false, for: 'live' },
    { oneOf: [[{ env: 'BOX_API_KEY', why: 'the box service', where: 'https://box.test/keys', required: true }, { env: 'BOX_PROJECT_ID', why: 'its project', where: 'https://box.test/projects', required: true }], { cmd: 'local-box', why: 'a box on this machine', required: true }], why: 'a box to run in', for: 'kill' },
  ],
  programs: [
    { cmd: 'demo-tool', why: 'runs the steps', required: true },
    { cmd: 'demo-fuse', why: 'mounts the disk', required: true, platforms: ['linux'], for: 'live' },
  ],
  expectedCalls: 10,
  expectedCost: 0.15,
};

test('a required key missing: the report names its env name and where to create it, exits 2, and sends no request', () => {
  const PATH = [bin('demo-tool', 'exit 0'), bin('demo-fuse', 'exit 0')].join(':');
  const report = checkKeys(SPEC, { env: { PATH, BOX_API_KEY: 'not-a-secret' }, platform: 'linux', live: true });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 2);
  assert.deepEqual(report.missing.map((item) => item.name), ['DEMO_API_KEY']);
  assert.match(report.text, /\n  MISSING  key DEMO_API_KEY: the demo service\n {11}set DEMO_API_KEY \(create it: https:\/\/example\.test\/keys\)\n/);
  assert.match(report.text, /optional key DEMO_REGION/);
  assert.match(report.text, /about 10 model calls, about \$0\.15/);
  assert.ok(!report.text.includes('not-a-secret'), 'a key\'s value is never printed');
  assert.equal(requests, 0);

  assert.equal(checkKeys(SPEC, { env: { PATH }, platform: 'linux' }).exitCode, 0, 'on fakes the live keys are not needed');
  assert.equal(checkKeys(SPEC, { env: { PATH, DEMO_API_KEY: 'x' }, platform: 'linux', live: true }).exitCode, 0);
  const kill = checkKeys(SPEC, { env: { PATH, DEMO_API_KEY: 'x', BOX_API_KEY: 'x' }, platform: 'linux', kill: true });
  assert.deepEqual(kill.missing.map((item) => item.name), ['BOX_API_KEY + BOX_PROJECT_ID or local-box'], 'an array member needs all of its items');
  assert.match(kill.missing[0].fix, /set BOX_PROJECT_ID .*; or install local-box/);
  assert.equal(checkKeys(SPEC, { env: { PATH, DEMO_API_KEY: 'x', BOX_API_KEY: 'x', BOX_PROJECT_ID: 'x' }, platform: 'linux', kill: true }).exitCode, 0);
  const nested = { ...SPEC, keys: [{ oneOf: [[{ env: 'BOX_API_KEY', why: 'the box', where: 'https://box.test', required: true }, { env: 'BOX_KILL_TOKEN', why: 'the kill', where: 'https://box.test', required: true, for: 'kill' }], { cmd: 'local-box', why: 'here', required: true, for: 'kill' }], why: 'a box' }] };
  assert.equal(checkKeys(nested, { env: { PATH, BOX_API_KEY: 'x' }, platform: 'linux', live: true }).exitCode, 0, 'a member\'s kill-only item is not needed live');
  assert.deepEqual(checkKeys(nested, { env: { PATH, BOX_API_KEY: 'x' }, platform: 'linux', kill: true }).missing.map((item) => item.name), ['BOX_API_KEY + BOX_KILL_TOKEN or local-box'], 'and is with --kill');
  assert.deepEqual(checkKeys(nested, { env: { PATH }, platform: 'linux' }).missing.map((item) => item.name), ['BOX_API_KEY'], 'on fakes the kill-only member drops out of the choice');
  const mac = checkKeys(SPEC, { env: { PATH, DEMO_API_KEY: 'x' }, platform: 'darwin', live: true });
  assert.equal(mac.exitCode, 2);
  assert.match(mac.text, /demo-fuse runs on linux only; this machine is darwin/);
});

test('a program below its minimum is refused naming both versions, and so is one whose version cannot be read', () => {
  const needs = (min) => ({ ...SPEC, keys: [], programs: [{ cmd: 'node', why: 'runs the demo', required: true, min }] });
  const low = checkKeys(needs('22.19.0'), { env: { PATH: bin('node', 'echo v22.18.0') } });
  assert.equal(low.exitCode, 2);
  assert.equal(low.missing[0].fix, 'node is 22.18.0; this run needs 22.19.0 or later');
  assert.equal(checkKeys(needs('22.19.0'), { env: { PATH: bin('node', 'echo v22.19.0') } }).exitCode, 0);
  assert.equal(checkKeys(needs('22.19.0'), { env: { PATH: bin('node', 'echo v24.1.0') } }).exitCode, 0);
  assert.equal(checkKeys(needs('0.8.42'), { env: { PATH: bin('node', 'echo "client 0.8.9 (build 1.2.3)" >&2') } }).missing[0].fix, 'node is 0.8.9; this run needs 0.8.42 or later', 'the first x.y.z, on stderr too');
  const unreadable = checkKeys(needs('22.19.0'), { env: { PATH: bin('node', 'echo unknown') } });
  assert.equal(unreadable.exitCode, 2);
  assert.match(unreadable.missing[0].fix, /node --version printed no x\.y\.z version/);
  assert.equal(checkKeys(needs('22.19.0'), { env: { PATH: bin('node', 'echo v22.19.0; exit 3') } }).exitCode, 2, 'a failing --version is not read');
  assert.equal(requests, 0);
});

test('a missing package prints the npm install --no-save line, and a choice may need one with its keys', () => {
  const demo = mkdtempSync(join(root, 'demo-'));
  const install = (version) => {
    mkdirSync(join(demo, 'node_modules', 'modal'), { recursive: true });
    writeFileSync(join(demo, 'node_modules', 'modal', 'package.json'), JSON.stringify({ name: 'modal', version }));
  };
  const spec = {
    ...SPEC, keys: [], programs: [],
    packages: [
      { name: 'left-pad-demo', version: '1.3.0', why: 'pads', required: false },
      { oneOf: [{ env: 'DAYTONA_API_KEY', why: 'Daytona', where: 'https://daytona.test', required: true }, [{ env: 'MODAL_TOKEN_ID', why: 'Modal', where: 'https://modal.test', required: true }, { env: 'MODAL_TOKEN_SECRET', why: 'Modal', where: 'https://modal.test', required: true }, { name: 'modal', version: '0.11.0', why: 'Modal\'s SDK', required: true }]], why: 'a sandbox' },
    ],
  };
  const env = { MODAL_TOKEN_ID: 'x', MODAL_TOKEN_SECRET: 'x' };
  const none = checkKeys(spec, { env, dir: demo });
  assert.equal(none.exitCode, 2);
  assert.match(none.missing[0].fix, /npm install --no-save modal@0\.11\.0$/);
  assert.match(none.text, /optional package left-pad-demo@1\.3\.0: pads\n {11}npm install --no-save left-pad-demo@1\.3\.0\n/);
  install('0.10.0');
  assert.match(checkKeys(spec, { env, dir: demo }).missing[0].fix, /npm install --no-save modal@0\.11\.0 \(found 0\.10\.0\)/);
  install('0.11.0');
  assert.equal(checkKeys(spec, { env, dir: demo }).exitCode, 0);
  assert.equal(checkKeys(spec, { env, dir: relative(process.cwd(), demo) }).exitCode, 0, 'a relative directory, from the current one');
  assert.equal(checkKeys(spec, { env: {}, dir: demo }).exitCode, 2, 'the package alone does not meet the choice');
  assert.equal(requests, 0);
});

test('Jev as the judge: a live run asks for TYPESAFE_API_KEY or OPENROUTER_API_KEY', () => {
  const spec = { ...SPEC, keys: [], programs: [], models: { lead: { needs: ['text'] }, judge: { jev: true } } };
  const report = checkKeys(spec, { env: {}, live: true });
  assert.deepEqual(report.missing.map((item) => item.name), ['TYPESAFE_API_KEY or OPENROUTER_API_KEY']);
  assert.equal(checkKeys(spec, { env: { OPENROUTER_API_KEY: 'x' }, live: true }).exitCode, 0);
  assert.equal(checkKeys(spec, { env: {} }).exitCode, 0, 'on fakes Jev is scripted');
});

const PROMPT = `# Set up the demo

| Env name | What | Where |
|---|---|---|
| \`DEMO_API_KEY\` | the demo service | https://example.test/keys |
| \`DEMO_REGION\` | optional | the console |

For the kill, either \`BOX_API_KEY\` with \`BOX_PROJECT_ID\`, or \`local-box\` on this machine.

**You run this yourself:** \`sudo apt install demo-fuse\`, then \`sudo visudo -cf /tmp/x.sudoers\`, and check that
\`demo-tool --version\` runs. Unmount with \`fusermount -u\`. Never paste your KEY into a chat.
`;

test('a setup prompt names every key, program and package in its spec, and no credential the spec does not list', () => {
  assert.deepEqual(checkSetupPrompt(SPEC, PROMPT), { ok: true, missing: [], extra: [] });
  const dropped = checkSetupPrompt(SPEC, PROMPT.replace('`BOX_PROJECT_ID`', 'the project'));
  assert.deepEqual(dropped, { ok: false, missing: ['BOX_PROJECT_ID'], extra: [] }, 'a choice member is required too');
  const extra = checkSetupPrompt(SPEC, `${PROMPT}\nAlso set \`OTHER_API_KEY\`, \`GH_TOKEN_RO\` and \`VAULT_SECRET\` and \`S3_KEY\` and \`GCP_PROJECT_ID\`; \`LOG_LEVEL\` is up to you.\n`);
  assert.deepEqual(extra.extra, ['OTHER_API_KEY', 'GH_TOKEN_RO', 'VAULT_SECRET', 'S3_KEY', 'GCP_PROJECT_ID'], 'only names that read as credentials');
  assert.equal(extra.ok, false);
  assert.deepEqual(checkSetupPrompt(SPEC, PROMPT.replace('`local-box`', '`local-box-2`')).missing, ['local-box'], 'a name inside a longer command is not a mention');
  assert.deepEqual(checkSetupPrompt({ ...SPEC, models: { lead: { needs: ['text'] }, judge: { jev: true } } }, `${PROMPT}\nJev: \`TYPESAFE_API_KEY\`, or \`OPENROUTER_API_KEY\`.\n`), { ok: true, missing: [], extra: [] });
  const withPackage = { ...SPEC, packages: [{ name: 'modal', version: '0.11.0', why: 'Modal', required: false }] };
  assert.deepEqual(checkSetupPrompt(withPackage, PROMPT).missing, ['modal']);
  assert.equal(checkSetupPrompt(withPackage, `${PROMPT}\nnpm install --no-save modal@0.11.0\n`).ok, true);
});
