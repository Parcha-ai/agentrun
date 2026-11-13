import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { RemoteConnectors } from '../dist/native/remote.js';
import { openSqliteStore } from '../dist/store/index.js';
import { scratch } from './support.mjs';

const registration = { installation_id: 'test-source', operation_id: 'connect', capabilities: { native_execution: true } };
const refused = error => {
  assert.equal(error.status, 401);
  assert.equal(error.code, 'unauthenticated');
  return true;
};
async function broker(t) {
  const store = await openSqliteStore({ file: join(await scratch(t), 'store.sqlite'), role: 'server' });
  t.after(() => store.close());
  let now = 1_000;
  return { remote: new RemoteConnectors(store, () => now), advance: ms => { now += ms; } };
}

test('remote enrollment authenticates its code before validating the registration body', async t => {
  const { remote, advance } = await broker(t);
  for (const token of ['', 'ar_enroll_unknown', 'ar_connector_wrong', 'ordinary-server-token']) {
    await assert.rejects(remote.register(token, {}), refused);
  }
  const { enrollment_token } = await remote.enroll({});
  await assert.rejects(remote.register(enrollment_token, {}), error => error.status === 422 && error.code === 'input_invalid');
  advance(10 * 60_000);
  await assert.rejects(remote.register(enrollment_token, {}), refused);
});

test('remote connector authentication reveals no distinction between unknown, wrong, revoked and expired credentials', async t => {
  const { remote, advance } = await broker(t);
  const firstCode = await remote.enroll({});
  const first = await remote.register(firstCode.enrollment_token, registration);
  const secondCode = await remote.enroll({});
  const second = await remote.register(secondCode.enrollment_token, registration);
  await remote.authenticate(first.connector.id, first.credential);
  let refusal;
  const sameRefusal = async (id, token) => assert.rejects(remote.authenticate(id, token), error => {
    refused(error);
    refusal ??= error.message;
    assert.equal(error.message, refusal);
    return true;
  });
  await sameRefusal('rc_unknown', first.credential);
  await sameRefusal(first.connector.id, second.credential);
  await sameRefusal(first.connector.id, 'ar_connector_wrong');
  await sameRefusal('rc_unknown', 'ar_connector_wrong');
  await sameRefusal(first.connector.id, '');
  await remote.revoke(first.connector.id);
  await sameRefusal(first.connector.id, first.credential);
  advance(30 * 24 * 60 * 60_000);
  await sameRefusal(second.connector.id, second.credential);
});

test('remote scoped authentication propagates real storage failures', async () => {
  const failure = new Error('settings storage failed');
  const remote = new RemoteConnectors({ settings: { get: async () => { throw failure; } } });
  await assert.rejects(remote.register('ar_enroll_unknown', {}), error => error === failure);
  await assert.rejects(remote.authenticate('rc_unknown', 'ar_connector_wrong'), error => error === failure);
});
