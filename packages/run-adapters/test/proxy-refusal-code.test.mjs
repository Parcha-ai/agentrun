// The model proxy's refusal of a request its admission refused carries the refusal's code beside its words when the run's
// spend cap refused it (`code: "spend_cap_reached"`), read from the admission error's fields alone: the cap's own error
// (CapRefused.code), or the runner's stop for the cap's verdict (HarnessRunError.refusal, from Refusal.code). An error
// whose words merely begin with the cap's code carries none: a reader (the run's Timeline) tells the cap's refusal by
// the body's fields, never by its words. No network: the provider is never reached.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';
import * as kernel from '@parcha/agentrun-kernel';

const { startModelProxy } = host;
const KEY = 'session-key-for-tests';
const WORDS = 'spend_cap_reached (out of budget): Not sent: the next step needs at least $0.02, and this run\'s cap is $0.01.';
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => ({ ...body, model: 'session-model' }),
  usageOf: () => undefined,
};

/** The proxy's answer to one request whose admission throws `error`: its status and its JSON body. */
async function refusedWith(t, error) {
  const fetch = async () => { throw new Error('the provider was reached'); };
  const p = await startModelProxy({
    policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0, log: () => {},
    hooks: { beforeRequest: async () => { throw error; }, afterRequest: async () => {} }, fetch,
  }, KEY);
  t.after(() => p.close());
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(p.url);
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test("the cap's own refusal (its code) and the runner's stop for the cap's verdict (its refusal) carry spend_cap_reached in the body", async (t) => {
  const own = await refusedWith(t, Object.assign(new Error(WORDS), { code: 'spend_cap_reached' }));
  assert.deepEqual([own.body.error.type, own.body.error.code], ['agentrun_proxy', 'spend_cap_reached'], JSON.stringify(own));
  const stopped = await refusedWith(t, new kernel.HarnessRunError('refused', 0, 0, { message: WORDS, refusal: 'spend_cap_reached' }));
  assert.deepEqual([stopped.body.error.type, stopped.body.error.code], ['agentrun_proxy', 'spend_cap_reached'], JSON.stringify(stopped));
  assert.match(stopped.body.error.message, /^refused before it was sent: spend_cap_reached/, 'its words as before');
});

test("a refusal whose words begin with the cap's code but whose fields say nothing of it carries no code", async (t) => {
  const worded = await refusedWith(t, new kernel.HarnessRunError('refused', 0, 0, { message: WORDS }));
  assert.equal(worded.body.error.type, 'agentrun_proxy');
  assert.equal('code' in worded.body.error, false, `matched by fields, never by words: ${JSON.stringify(worded)}`);
  const other = await refusedWith(t, Object.assign(new Error('the turn cap was reached'), { code: 'HARNESS_NODE_NOT_DELIVERED' }));
  assert.equal('code' in other.body.error, false, `another error's code is not the refusal's: ${JSON.stringify(other)}`);
});
