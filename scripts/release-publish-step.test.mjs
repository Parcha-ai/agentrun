// The release workflow's publish step, run whole in a scratch directory: a stub npm that records each publish, a stub
// verify-published that answers as the registry would, and a publish set of three packages in two layers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const step = (() => {
  const name = workflow.indexOf('- name: Publish exact verified archives in dependency order');
  const start = workflow.indexOf('run: |\n', name) + 'run: |\n'.length;
  const end = workflow.indexOf('\n      - name:', start);
  assert.ok(name > 0 && start > name && end > start, 'release.yml has the publish step');
  return workflow.slice(start, end).split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
})();

// Stub verify-published: --allow-absent exits 3 (absent), 0 (EXISTING: the same bytes are there) or 1 (MISMATCH: other bytes);
// a plain verification waits a little, so a layer's waits can be seen to overlap, then passes unless the package is BAD.
const verifier = `import { appendFileSync, writeFileSync } from 'node:fs';
const [, , , pkg, flag] = process.argv;
const has = name => (process.env[name] ?? '').split(' ').includes(pkg);
const log = event => appendFileSync('events.log', event + ' ' + pkg + '\\n');
if (flag === '--allow-absent') { if (has('EXISTING')) { log('exists'); process.exit(0); } if (has('MISMATCH')) { log('mismatch'); process.exit(1); } process.exit(3); }
log('wait');
setTimeout(() => {
  log(has('BAD') ? 'failed' : 'verified');
  writeFileSync('.release/published-' + pkg + '.json', JSON.stringify({ status: has('BAD') ? 'failed' : 'passed' }));
  process.exit(has('BAD') ? 1 : 0);
}, 300);
`;
const preflight = `export const releasePackages = ['a', 'b', 'c'];
export const releaseLayers = directories => [directories.filter(d => d !== 'c'), ['c']];
`;

async function publish(env) {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-publish-run-'));
  try {
    await mkdir(join(dir, 'scripts'));
    await mkdir(join(dir, 'bin'));
    await mkdir(join(dir, '.release'));
    await writeFile(join(dir, 'scripts/release-preflight.mjs'), preflight);
    await writeFile(join(dir, 'scripts/verify-published.mjs'), verifier);
    await writeFile(join(dir, '.release/release-plan.json'), JSON.stringify({ packages: ['a', 'b', 'c'].map(directory => ({ directory, filename: `${directory}.tgz` })) }));
    // Stub npm: records each publish; a package named in PUBLISH_FAILS is refused, as npm refuses a publish it cannot complete.
    await writeFile(join(dir, 'bin/npm'), '#!/bin/sh\nfor arg; do case "$arg" in .release/packages/*) pkg=$(echo "${arg#.release/packages/}" | sed "s/\\.tgz$//"); case " $PUBLISH_FAILS " in *" $pkg "*) echo "publish-failed $pkg" >> events.log; exit 1;; esac; echo "publish $pkg" >> events.log;; esac; done\n');
    await chmod(join(dir, 'bin/npm'), 0o755);
    await writeFile(join(dir, 'events.log'), '');
    const result = await exec('bash', ['-e', '-c', step], { cwd: dir, env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, RELEASE_TAG: 'v0.1.0-beta.99', ...env } })
      .then(out => ({ status: 0, ...out }), error => ({ status: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
    const receipt = async directory => { try { return JSON.parse(await readFile(join(dir, `.release/published-${directory}.json`), 'utf8')).status; } catch { return undefined; } };
    return { ...result, events: (await readFile(join(dir, 'events.log'), 'utf8')).trim().split('\n').filter(Boolean), receipts: { a: await receipt('a'), b: await receipt('b'), c: await receipt('c') } };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('each layer is published, then its packages wait for the registry together, before the next layer is published', async () => {
  const { status, stderr, events } = await publish({});
  assert.equal(status, 0, stderr);
  assert.deepEqual(events.slice(0, 2), ['publish a', 'publish b'], 'both packages of the first layer go out before any wait');
  assert.deepEqual(events.slice(2, 6).sort(), ['verified a', 'verified b', 'wait a', 'wait b']);
  assert.ok(events.indexOf('wait b') < events.indexOf('verified a'), 'the first layer\'s waits overlap');
  assert.deepEqual(events.slice(6), ['publish c', 'wait c', 'verified c']);
});

test('a failed verification stops the release before the next layer is published', async () => {
  const { status, stderr, events } = await publish({ BAD: 'b' });
  assert.notEqual(status, 0);
  assert.match(stderr, /a package of the layer 'a b' failed verification; later layers were not published/);
  assert.ok(events.includes('failed b') && events.includes('verified a'), 'the other package of the layer is still verified');
  assert.ok(!events.includes('publish c'), 'the next layer is never published');
});

test('a resumed release skips a version already published with the same bytes, and verifies the rest', async () => {
  const { status, stderr, events } = await publish({ EXISTING: 'a' });
  assert.equal(status, 0, stderr);
  assert.ok(events.includes('exists a') && !events.includes('publish a') && !events.includes('wait a'), 'a is neither published again nor waited on');
  assert.ok(events.includes('publish b') && events.includes('verified b') && events.includes('publish c'));
});

test('a version already published with other bytes is never published over, and nothing after it goes out', async () => {
  const { status, events } = await publish({ MISMATCH: 'b' });
  assert.equal(status, 1);
  assert.ok(events.includes('mismatch b') && !events.includes('publish b'), 'b is refused, not republished');
  assert.ok(!events.includes('publish c'), 'the next layer is never published');
});

test('a publish that fails partway through a layer still verifies what the layer published, then stops before the next layer', async () => {
  const { status, stderr, events, receipts } = await publish({ PUBLISH_FAILS: 'b' });
  assert.notEqual(status, 0);
  assert.match(stderr, /publishing b failed; the packages this layer published before it were verified, later layers were not published/);
  assert.deepEqual(events.slice(0, 2), ['publish a', 'publish-failed b']);
  assert.ok(events.includes('verified a'), 'a, already live, is verified');
  assert.deepEqual(receipts, { a: 'passed', b: undefined, c: undefined }, 'a\'s receipt says what the registry holds; nothing claims b or c');
  assert.ok(!events.includes('publish c'), 'the next layer is never published');
});
