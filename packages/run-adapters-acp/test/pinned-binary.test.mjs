// The pinned-binary checks: a binary whose sha256 differs from its pin is refused with a named code, read and never run;
// an agent with no registry digest has its first verified digest recorded, and a later binary that differs is refused.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACP_CODES, acpPlatform, AcpBinaryRefused, fileDigestRecord, GOOSE_PIN, verifyFirstSeen, verifyPinnedBinary, verifyPinnedBinaryAsync } from '@parcha/agentrun-harness-acp';
import { scratch } from './helpers.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
/** A script that leaves a mark if it is ever run: the checks read it and never start it. */
function binary(dir, name = 'agent') {
  const mark = join(dir, `${name}.ran`);
  const path = join(dir, name);
  const text = `#!/bin/sh\necho ran > '${mark}'\n`;
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return { path, mark, sha256: sha(text) };
}
const refusedWith = (code) => (error) => error instanceof AcpBinaryRefused && error.code === code && error.message.startsWith(`${code}: `);

test('Goose 1.59.2 is pinned as the registry lists it, its linux-x86_64 binary measured', () => {
  assert.equal(GOOSE_PIN.version, '1.59.2');
  assert.equal(GOOSE_PIN.source.url, 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json');
  assert.ok(!Number.isNaN(Date.parse(GOOSE_PIN.source.readAt)));
  assert.deepEqual(GOOSE_PIN.archives['linux-x86_64'], {
    url: 'https://github.com/block/goose/releases/download/v1.59.2/goose-x86_64-unknown-linux-gnu.tar.bz2',
    format: 'tar.bz2',
    sha256: '36efe207ae4f8de3030ed8fdcfe3b7c5d13f23d6cb73d6fde747543f022ce218',
    cmd: './goose',
    binarySha256: 'b90833d7f1e8f9aa36e163a8f3d27fdd69d462ac9b4a68105a091e1a2da56993',
  });
  const mac = GOOSE_PIN.archives['darwin-aarch64'];
  assert.equal(mac.url, 'https://github.com/block/goose/releases/download/v1.59.2/goose-aarch64-apple-darwin.tar.bz2');
  assert.match(mac.sha256, /^[0-9a-f]{64}$/);
  assert.equal(mac.binarySha256, undefined, 'unmeasured: its install records the first one');
  assert.ok(Object.isFrozen(GOOSE_PIN) && Object.isFrozen(GOOSE_PIN.archives));
});

test('the platform is named as the registry names it', () => {
  assert.equal(acpPlatform('linux', 'x64'), 'linux-x86_64');
  assert.equal(acpPlatform('darwin', 'arm64'), 'darwin-aarch64');
  assert.equal(acpPlatform('win32', 'x64'), 'windows-x86_64');
  assert.equal(acpPlatform('freebsd', 'x64'), undefined);
  assert.equal(acpPlatform('linux', 'ia32'), undefined);
});

test('a binary with its pinned sha256 passes; one that differs is refused, ACP_BINARY_MISMATCH; neither is run', async () => {
  const dir = scratch();
  const good = binary(dir, 'good');
  verifyPinnedBinary(good.path, good.sha256);
  await verifyPinnedBinaryAsync(good.path, good.sha256);
  const other = sha('another build');
  assert.throws(() => verifyPinnedBinary(good.path, other), refusedWith(ACP_CODES.binaryMismatch));
  await assert.rejects(verifyPinnedBinaryAsync(good.path, other), refusedWith(ACP_CODES.binaryMismatch));
  // A binary swapped after it passed is checked again, and refused.
  writeFileSync(good.path, '#!/bin/sh\necho swapped\n');
  assert.throws(() => verifyPinnedBinary(good.path, good.sha256), refusedWith(ACP_CODES.binaryMismatch));
  assert.equal(existsSync(good.mark), false, 'the check never ran the binary');
  assert.throws(() => verifyPinnedBinary(join(dir, 'missing'), good.sha256), refusedWith(ACP_CODES.binaryUnreadable));
  assert.throws(() => verifyPinnedBinary(good.path, 'not-a-digest'), /not 64 lowercase hex/);
});

test('with no registry digest, the first verified digest is recorded and a later binary that differs is refused', () => {
  const dir = scratch();
  const first = binary(dir, 'cursor-agent');
  const record = fileDigestRecord(join(dir, 'pins', 'cursor.sha256'));
  assert.equal(record.read(), undefined);
  assert.equal(verifyFirstSeen(first.path, record), first.sha256);
  assert.equal(readFileSync(join(dir, 'pins', 'cursor.sha256'), 'utf8'), `${first.sha256}\n`);
  // The same binary passes again; the record is not written again.
  assert.equal(verifyFirstSeen(first.path, record), first.sha256);
  // A new build in its place drifts from the first: refused, and the record keeps the first.
  writeFileSync(first.path, '#!/bin/sh\necho a new build\n');
  assert.throws(() => verifyFirstSeen(first.path, record), refusedWith(ACP_CODES.binaryDrift));
  assert.equal(record.read(), first.sha256);
  assert.equal(existsSync(first.mark), false, 'never run');
});

test('two processes that record a first digest at once: the first record holds, and a different binary drifts from it', () => {
  const dir = scratch();
  const a = binary(dir, 'a');
  const file = join(dir, 'first.sha256');
  // A record whose read saw none, then lost the race to another writer.
  let raced = false;
  const racing = { read: () => (raced ? fileDigestRecord(file).read() : undefined), write: (d) => { fileDigestRecord(file).write(sha('the other process')); raced = true; fileDigestRecord(file).write(d); } };
  assert.throws(() => verifyFirstSeen(a.path, racing), refusedWith(ACP_CODES.binaryDrift));
  assert.equal(fileDigestRecord(file).read(), sha('the other process'));
});
