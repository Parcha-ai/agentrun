// The one scanner (examples/reference/scan.ts) beyond its fixed shapes: loopback and private-network endpoints, the exact
// values of the secret env vars a demo names (read at record time, never written, named in an error by their env name
// only), and this machine's host names. Every value here is a fake.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { finishRecording, openRecorder } from './reference/record.ts';
import { credentialIn, credentialInFile, exposuresOf, secretNamesOf } from './reference/scan.ts';

test('a loopback or private-network endpoint is refused; a public one, a near miss and a version are not', () => {
  for (const text of ['http://127.0.0.1:9421/v1', 'ws://10.2.3.4/x', '172.16.0.9', 'at 172.31.255.1:80', '192.168.1.20', 'http://169.254.169.254/latest', 'http://[::1]:8080/', 'fd12:3456:789a::1', 'fe80::1ff:fe23:4567:890a']) {
    assert.equal(credentialIn(text), 'private network address', text);
  }
  for (const text of ['http://8.8.8.8/', '172.32.0.1', '192.169.1.1', 'v10.2.3', '1.10.0.1', 'node 22.10.0', 'a sha fd12abcd', 'commit 127', '110.0.0.1']) {
    assert.equal(credentialIn(text), undefined, text);
  }
});

test('a named secret\'s value is refused, raw and behind a JSON escape, and named by its env name, never its value', () => {
  const value = `fake-${'value'.repeat(4)}"9`;
  const exposures = exposuresOf(['FAKE_SERVICE_KEY'], { env: { FAKE_SERVICE_KEY: value }, host: 'x' });
  assert.equal(credentialIn(`header ${value} sent`, exposures), 'secret (the value of FAKE_SERVICE_KEY)');
  // In a JSON file the quote in the value is escaped, so the raw text does not hold it; the decoded string does.
  assert.equal(credentialInFile('blob.json', JSON.stringify({ header: value }), exposures), 'secret (the value of FAKE_SERVICE_KEY)');
  assert.equal(credentialIn('header another-fake-value sent', exposures), undefined);
  assert.ok(!exposures.some((exposure) => exposure.label.includes(value)), 'the label never holds the value');
});

test('a value under 8 characters is not scanned for, and one stderr line names its env var, never its value', () => {
  const warned = [];
  const exposures = exposuresOf(['FAKE_SHORT', 'FAKE_UNSET'], { env: { FAKE_SHORT: 'abc123' }, host: 'x', warn: (line) => warned.push(line) });
  assert.deepEqual(exposures, []);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /FAKE_SHORT is under 8 characters, too short to scan/);
  assert.doesNotMatch(warned[0], /abc123/);
});

test('this machine\'s host name and its first label are refused; localhost and a short name are not scanned for', () => {
  const exposures = exposuresOf([], { env: {}, host: 'build-box-7.lan.example' });
  assert.equal(credentialIn('ran on build-box-7.lan.example', exposures), 'host name of this machine');
  assert.equal(credentialIn('ran on BUILD-BOX-7 today', exposures), 'host name of this machine');
  assert.equal(credentialIn('ran on build-box-70', exposures), undefined, 'a longer name is another machine');
  assert.deepEqual(exposuresOf([], { env: {}, host: 'localhost' }), []);
  assert.deepEqual(exposuresOf([], { env: {}, host: 'box' }), []);
});

test('a demo\'s secrets are every env name under its keys, oneOf members and arrays included', () => {
  const demo = { title: 't', keys: [
    { oneOf: [{ env: 'FAKE_A_KEY' }, { env: 'FAKE_B_KEY' }] },
    { env: 'FAKE_C_KEY', required: true },
    { oneOf: [[{ env: 'FAKE_D_KEY' }, { env: 'FAKE_D_PROJECT' }], { env: 'FAKE_E_KEY' }] },
  ], programs: [{ env: 'NOT_A_KEY' }] };
  assert.deepEqual(secretNamesOf(demo).sort(), ['FAKE_A_KEY', 'FAKE_B_KEY', 'FAKE_C_KEY', 'FAKE_D_KEY', 'FAKE_D_PROJECT', 'FAKE_E_KEY']);
  assert.deepEqual(secretNamesOf({}), []);
});

test('the recorder refuses a recording that holds a named secret\'s value, says which env var, and writes no manifest', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-scan-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const name = 'AGENTRUN_FAKE_TEST_SECRET';
  const value = `fake-secret-${'0123456789'.repeat(2)}`;
  process.env[name] = value;
  t.after(() => { delete process.env[name]; });
  const dir = join(tmp, 'recording');
  const recorder = openRecorder({ dir });
  recorder.host('process.started', { pid: 1 });
  recorder.live('workflow', 'node.start', { note: `called with ${value}` });
  const header = { title: 't', task: 't', model: 'm', generations: 1, kills: 0, code: { repo: 'r', commit: 'c', packages: {} }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') } };
  assert.throws(() => finishRecording(dir, header, { secrets: [name] }), (error) => {
    assert.match(error.message, new RegExp(`a secret \\(the value of ${name}\\) in events\\.jsonl`));
    assert.ok(!error.message.includes(value), 'the error never prints the value');
    return true;
  });
  assert.ok(!existsSync(join(dir, 'manifest.json')));
});
