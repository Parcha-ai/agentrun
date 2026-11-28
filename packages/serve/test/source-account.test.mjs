import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceAccountMetadata, sourceAccountContainsSecret } from '../dist/native/source-account.js';
const now = Date.parse('2030-01-01T00:00:00Z');
const jwt = claims => [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'Zml4dHVyZQ'].join('.');
const classify = value => sourceAccountMetadata(Buffer.from(JSON.stringify(value)), now);
const auth = (plan = 'pro') => ({ auth_mode: 'chatgpt', last_refresh: '2030-01-01T00:00:00Z', tokens: {
  id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: plan, chatgpt_account_id: 'old', chatgpt_user_id: 'user' } }),
  access_token: jwt({ exp: now / 1000 + 3600 }), refresh_token: 'not-a-secret', account_id: 'old' } });
test('auth metadata follows native mode precedence without emitting native credentials', () => {
  assert.deepEqual(classify({ OPENAI_API_KEY: 'fake-test-key' }), { source: 'codex-auth-file', mode: 'apikey', plan: null });
  assert.equal(classify({ OPENAI_API_KEY: 'fake-test-key', personal_access_token: 'not-a-secret' }).mode, 'unknown');
  assert.equal(classify({ ...auth('enterprise'), OPENAI_API_KEY: 'fake-test-key' }).plan, 'managed', 'explicit ChatGPT mode wins');
  assert.equal(sourceAccountMetadata(new Uint8Array(65_537), now).mode, 'unknown');
});
test('saved workspace selection cannot borrow a different account or user plan', () => {
  const value = auth(); value.tokens.account_id = 'new';
  value.tokens.access_token = jwt({ exp: now / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'new', chatgpt_user_id: 'user' } });
  assert.equal(classify(value).plan, 'ordinary');
  value.tokens.access_token = jwt({ exp: now / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'new', chatgpt_user_id: 'different' } });
  assert.equal(classify(value).plan, 'unknown');
});
test('refresh-due and malformed saved metadata never claims a portable account', () => {
  const value = auth(); value.tokens.access_token = jwt({ exp: now / 1000 + 300 });
  assert.equal(classify(value).plan, 'unknown');
  for (const claims of [{ chatgpt_plan_type: 'pro', chatgpt_account_is_fedramp: true },
    { chatgpt_plan_type: 'pro', chatgpt_account_is_fedramp: 'false' }, { chatgpt_plan_type: 'pro', chatgpt_account_id: 1 }]) {
    const changed = auth(); changed.tokens.id_token = jwt({ 'https://api.openai.com/auth': claims });
    assert.notEqual(classify(changed).plan, 'ordinary');
  }
});

test('Pi private credential scan rejects OAuth, MCP, and custom credential environment copies without emitting values', () => {
  const privateState = Buffer.from(JSON.stringify({ provider: { type: 'oauth', access: 'fixture-private-access', refresh: 'fixture-private-refresh', expires: 123 },
    api: { type: 'api_key', key: 'fixture-private-key', env: { CUSTOM_AUTH: 'fixture-private-env' } },
    mcp: { pending: { codeVerifier: 'fixture-private-verifier' }, client: { client_secret: 'not-a-secret' } } }));
  for (const value of ['fixture-private-access', 'fixture-private-refresh', 'fixture-private-key', 'fixture-private-env', 'fixture-private-verifier', 'not-a-secret']) {
    for (const encoded of [value, Buffer.from(value).toString('base64')])
      assert.equal(sourceAccountContainsSecret(privateState, [`ordinary project file ${encoded}`], 'pi'), true);
  }
  assert.equal(sourceAccountContainsSecret(privateState, ['ordinary project file without credentials'], 'pi'), false);
  for (const bytes of [Buffer.from('{'), Buffer.from('null'), Buffer.from('[]'), Buffer.alloc(65_537)])
    assert.equal(sourceAccountContainsSecret(bytes, [], 'pi'), true, 'uninspectable private auth must prevent publication');
});
