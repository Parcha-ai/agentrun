// A host whose provider credential renews (a person's sign-in) hears from the model proxy when the provider answered 401
// to the credential a request carried (ModelProxyOptions.credentialRefused), and only then; and a credential its host says
// is gone (CredentialUnavailable) refuses the request in the host's words, with no request sent. No network: the provider
// is a fake fetch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';

const { startModelProxy, CredentialUnavailable } = host;
const KEY = 'session-key-for-tests';
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => ({ ...body, model: 'session-model' }),
  usageOf: () => undefined,
};

/** A proxy over a provider that answers each request with the next of `statuses`, and what it was told and sent. */
async function proxyOver(t, statuses, credential) {
  const seen = { sent: [], refused: [] };
  let turn = 0;
  const fetch = async (_url, init) => {
    seen.sent.push(new Headers(init.headers).get('authorization'));
    return Response.json({ ok: true }, { status: statuses[turn++] ?? 200 });
  };
  const p = await startModelProxy({
    policy, model: 'session-model', origin: 'https://provider.invalid', credential, price: () => 0, log: () => {},
    hooks: { beforeRequest: async () => ({}), afterRequest: async () => {} }, fetch,
    credentialRefused: (sent) => void seen.refused.push(sent),
  }, KEY);
  t.after(() => p.close());
  const ask = async () => {
    const res = await globalThis.fetch(`${p.url}/v1/test`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: '{}' });
    return { status: res.status, body: await res.json() };
  };
  return { seen, ask };
}

test('a 401 tells the host the credential that request carried; any other answer tells it nothing', async (t) => {
  const tokens = ['fake-first', 'fake-second'];
  let at = 0;
  const { seen, ask } = await proxyOver(t, [200, 401, 200], () => tokens[Math.min(at++, tokens.length - 1)]);
  assert.equal((await ask()).status, 200);
  assert.deepEqual(seen.refused, []);
  assert.equal((await ask()).status, 401, 'the 401 reaches the client as the provider said it');
  assert.deepEqual(seen.refused, ['fake-second']);
  assert.equal((await ask()).status, 200);
  assert.deepEqual(seen.refused, ['fake-second'], 'told once, for the request refused');
});

test("a credential its host says is gone refuses the request in the host's words, with no request sent", async (t) => {
  const words = 'This example sign-in expired: sign in again.';
  const { seen, ask } = await proxyOver(t, [], () => { throw new CredentialUnavailable(words); });
  const refused = await ask();
  assert.equal(refused.body.error.message, words);
  assert.equal(refused.body.error.code, 'credential_unavailable');
  assert.ok(refused.status >= 400 && refused.status < 500, `a refusal the client does not retry: ${refused.status}`);
  assert.deepEqual(seen.sent, [], 'the provider was never reached');
});
