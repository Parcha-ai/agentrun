// A fake of the OpenAI endpoints the sign-in reaches: the OAuth token endpoint (codes and rotating refresh tokens), the
// account's model list, and the Responses API. It listens on 127.0.0.1 and counts only requests that carry its own
// secret, which `redirect` adds; anything else is a foreign request, counted apart and answered 404.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const HOSTS = new Set(['auth.openai.com', 'api.openai.com']);
const realFetch = globalThis.fetch;

/** A fetch that sends auth.openai.com and api.openai.com to `base` with `secret`, and refuses every other host. */
export function redirect(base, secret, inner = realFetch) {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!HOSTS.has(url.host)) throw new Error(`a test reached ${url.host}`);
    const headers = new Headers(request.headers);
    headers.set('x-fake-secret', secret);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    return inner(new URL(url.pathname + url.search, base), { method: request.method, headers, body, signal: request.signal });
  };
}

const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const answer = (text) => sse([
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
  { type: 'response.output_text.delta', output_index: 0, delta: text },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text }] } },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
]);
const LIMIT = { message: 'The usage limit for this plan is reached.', type: 'usage_limit', code: 'subscription_sharing_usage_limit_exceeded' };

/**
 * `models`: the account's list, as GET /v1/models returns it. `responses`: 'ok', 'limit' (429 at the start) or
 * 'limit-midstream' (a response.failed event). `tokenDelayMs` holds every token answer that long. The first refresh
 * token it accepts is `refresh`; each refresh retires the one it was sent and issues the next.
 */
export async function fakeOpenAI({ models = [], responses = 'ok', tokenDelayMs = 0, refresh = 'refresh-1', code = 'code-1' } = {}) {
  const secret = randomUUID();
  const seen = { token: [], refreshSent: [], reused: [], codes: [], models: [], responses: [], foreign: 0 };
  const live = new Set([refresh]);
  let issued = 1;
  const issue = () => {
    issued += 1;
    const next = `refresh-${issued}-${randomUUID()}`;
    live.add(next);
    return { access_token: `access-${issued}-${randomUUID()}`, refresh_token: next, id_token: `id-${issued}-${randomUUID()}`, expires_in: 3600, scope: 'openid offline_access chatgpt.tokens.use.direct' };
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      if (req.headers['x-fake-secret'] !== secret) { seen.foreign += 1; res.writeHead(404).end(); return; }
      const body = Buffer.concat(chunks).toString('utf8');
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.method === 'POST' && req.url === '/api/accounts/oauth/token') {
        const form = new URLSearchParams(body);
        seen.token.push(form.get('grant_type'));
        if (tokenDelayMs) await new Promise((done) => setTimeout(done, tokenDelayMs));
        if (form.get('grant_type') === 'authorization_code') {
          seen.codes.push(form.get('code'));
          return form.get('code') === code ? json(200, issue()) : json(400, { error: 'invalid_grant' });
        }
        const sent = form.get('refresh_token');
        seen.refreshSent.push(sent);
        if (!live.delete(sent)) { seen.reused.push(sent); return json(400, { error: 'invalid_grant' }); }
        return json(200, issue());
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        seen.models.push(req.headers.authorization);
        return json(200, { object: 'list', data: models });
      }
      if (req.method === 'POST' && req.url === '/v1/responses') {
        seen.responses.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
        if (responses === 'limit') return json(429, { error: LIMIT });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(responses === 'limit-midstream'
          ? sse([{ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }, { type: 'response.failed', response: { id: 'resp_1', status: 'failed', error: LIMIT } }])
          : answer('hello'));
        return;
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, secret, seen,
    fetch: redirect(base, secret),
    /** A request without the secret: it must be counted as foreign, never as one of this test's. */
    probe: () => realFetch(`${base}/v1/models`).then((response) => response.status),
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  };
}
