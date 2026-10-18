// The scan refuses a URL that carries a credential in its query, whoever recorded it: a live view's link, a connect or debugger
// URL, a signed link. It names the parameter and never its value. The shapes are pi-browser's own sentinels (the fake Browserbase
// and Kernel URLs a host test registers), so a host that records one is refused the way a real one would be.
import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialIn, credentialInFile, credentialInValue } from '../../packages/reference/src/scan.ts';
import { makeSentinels } from '../../packages/pi-browser/src/testing/sentinels.ts';

const s = makeSentinels();
/** The sentinel connect URL with its key swapped for a value no shape recognises: what a real provider's opaque token looks like. */
const opaque = (url) => url.replace(s.bbApiKey, 'opaque-api-value');
/** What the message may say of each shape: its kind and the parameter's name. */
const CASES = [
  ['Browserbase connect URL (apiKey, signingKey), the key opaque', opaque(s.bbConnectUrl), 'url with a token-bearing query parameter (apiKey)'],
  ['Browserbase live view URL (a token parameter, on a devtools host)', s.bbLiveViewUrl, 'url with a token-bearing query parameter (token)'],
  ['a signed page link (api_key)', s.pageUrl, 'url with a token-bearing query parameter (api_key)'],
  ['a websocket URL with a query, no token-bearing name', 'wss://kernel.sentinel.test/browser/cdp?session=opaque', 'websocket url with a query (session)'],
  ['a ws:// URL with a query', 'ws://127.0.0.1:9222/devtools/browser/abc?x=1', 'websocket url with a query (x)'],
  ['a Browserbase debugger URL with any query', 'https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com/debug/abc', 'live-view, debugger or connect url with a query (wss)'],
  ['the Browserbase connect host with any query', 'https://connect.browserbase.com/?region=us', 'live-view, debugger or connect url with a query (region)'],
  ['a DevTools inspector page with any query', 'http://localhost:9222/devtools/inspector.html?ws=localhost:9222/devtools/page/1', 'live-view, debugger or connect url with a query (ws)'],
];
const TOKEN_NAMES = ['token', 'access_token', 'apiKey', 'api_key', 'key', 'signature', 'sig', 'X-Amz-Signature', 'X-Goog-Signature'];

test('each credential-bearing URL shape is refused by its parameter, and the message holds no value', () => {
  const values = [s.bbApiKey, s.bbSigningKey, s.bbSessionId, s.bbLiveViewToken, s.pageApiKey, s.pageSigningKey, s.pageToken, 'opaque'];
  for (const [what, url, expected] of CASES) {
    const found = credentialIn(`the host recorded ${url} for the session`);
    assert.equal(found, expected, what);
    for (const value of values) assert.ok(!found.includes(value), `${what}: the message repeats a value`);
  }
});

test('the sentinel connect URL, whose key has a shape of its own, is refused as before', () => {
  assert.equal(credentialIn(s.bbConnectUrl), 'browserbase api key');
});

test('every token-bearing parameter name is refused with any value, an empty one too, in any case', () => {
  for (const name of TOKEN_NAMES) {
    for (const value of ['v', '', '0123456789abcdef']) {
      for (const written of [name, name.toUpperCase(), name.toLowerCase()]) {
        assert.equal(credentialIn(`https://example.test/a?page=1&${written}=${value}&x=2`), `url with a token-bearing query parameter (${written})`, `${written}=${value}`);
      }
    }
  }
  assert.equal(credentialIn('https://example.test/a?token'), 'url with a token-bearing query parameter (token)', 'a parameter with no =');
  assert.equal(credentialIn('https://example.test/a?%74oken=1'), 'url with a token-bearing query parameter (token)', 'a percent-encoded name');
});

test('a plain link, and a name that only contains a token word, pass', () => {
  for (const url of [
    'https://example.com/search?q=cats&page=2',
    'https://example.com/a/b?',
    'https://example.com/a/b#token=1',
    'https://example.com/?sort_key=1&monkey=2&keys=a&tokens=3&signing=4&design=5',
    'wss://connect.browserbase.com/',
    'ws://127.0.0.1:9222/devtools/browser/abc',
    'https://www.browserbase.com/pricing?ref=x',
    'https://docs.browserbase.com/introduction?utm=docs',
    'See https://example.com/docs. The token is not here, nor is a key=value pair.',
  ]) assert.equal(credentialIn(url), undefined, url);
});

test('it is found raw in a text, and behind a JSON escape in a file or a value', () => {
  const url = s.bbLiveViewUrl;
  const line = JSON.stringify({ channel: 'live', data: { liveView: { url } } });
  assert.equal(credentialIn(line), 'url with a token-bearing query parameter (token)', 'raw JSON text');
  assert.equal(credentialInFile('events.jsonl', `${line}\n`), 'url with a token-bearing query parameter (token)');
  assert.equal(credentialInValue({ liveView: { url } }), 'url with a token-bearing query parameter (token)');
  // `&` written as &, as some encoders do: the raw text stops at the escape, the decoded value does not.
  const escaped = JSON.stringify({ url: 'https://example.test/live?view=1&token=abc' }).replaceAll('&', '\\u0026');
  assert.equal(credentialInFile('events.jsonl', escaped), 'url with a token-bearing query parameter (token)');
  assert.equal(credentialInFile('events.jsonl', JSON.stringify({ url: 'https://example.test/live?q=1' })), undefined);
});
