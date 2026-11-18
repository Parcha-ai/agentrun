// A scripted Anthropic Messages origin on plain-http loopback, for the tests that run the real Goose binary: it records
// every request (method, path, headers, body) and answers each with the script's next step. No real model, no spend.
// The default script reads the conversation the request carries:
//   - a tool_result in the last user message      -> text "TOOL_RESULT_SEEN: <its first 80 characters>"
//   - "CALL_ECHO" in the prompt                    -> a tool_use of the offered tool whose name ends in "echo"
//   - "CALL_SKILL" in the prompt                   -> a tool_use of load_skill
//   - "SAY <words>" in the prompt                  -> text "<words>"
//   - anything else                                -> text "PLAIN_REPLY"
// GET /v1/models is answered with one model, so a test that forwards it sees it reach here.
import { createServer } from 'node:http';

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? `[tool_result ${JSON.stringify(b.content).slice(0, 200)}]` : `[${b.type}]`)).join(' '));

/** What the default script answers `body` with: `{ text }` or `{ tool, input }`. */
export function defaultStep(body) {
  const msgs = body.messages ?? [];
  const last = msgs.at(-1);
  const tools = (body.tools ?? []).map((t) => t.name);
  const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
  if (results.length) return { text: `TOOL_RESULT_SEEN: ${JSON.stringify(results[0].content).slice(0, 80)}` };
  const prompt = textOf(msgs.filter((m) => m.role === 'user').at(-1)?.content);
  if (/CALL_ECHO/.test(prompt)) {
    const tool = tools.find((t) => /echo$/.test(t));
    return tool ? { tool, input: { text: 'hello from the fake model' } } : { text: `NO_ECHO_TOOL among [${tools.join(',')}]` };
  }
  if (/CALL_SKILL/.test(prompt)) return tools.includes('load_skill') ? { tool: 'load_skill', input: { name: 'fake-skill' } } : { text: 'NO_SKILL_TOOL' };
  const say = /SAY (\S+)/.exec(prompt);
  if (say) return { text: say[1] };
  return { text: 'PLAIN_REPLY' };
}

/** Starts the origin. `step(body, n)`: the answer to the nth Messages request (default `defaultStep`); `usage`: the
 *  tokens each answer reports, or `usage(body, n)` for them. Close destroys every open socket, so a listener held open by
 *  another process ends too. */
export async function fakeAnthropic({ step = defaultStep, usage: usageOf = { input_tokens: 1000, output_tokens: 100 } } = {}) {
  const requests = [];
  const sockets = new Set();
  let n = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* kept as raw below */ }
      // Only requests for the API's paths are the origin's; a port watcher's GET / is no request of the agent's.
      if (!req.url?.startsWith('/v1/')) { res.writeHead(404); res.end(); return; }
      requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, body, raw });
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'origin-listed-model', type: 'model', display_name: 'fake' }], has_more: false }));
        return;
      }
      if (req.url !== '/v1/messages') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return; }
      const id = ++n;
      const plan = step(body, id);
      const usage = typeof usageOf === 'function' ? usageOf(body, id) : usageOf;
      const block = plan.tool ? { type: 'tool_use', id: `toolu_fake_${id}`, name: plan.tool, input: plan.input } : { type: 'text', text: plan.text };
      const stop = plan.tool ? 'tool_use' : 'end_turn';
      const message = { id: `msg_fake_${id}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...message, content: [block], stop_reason: stop, usage }));
        return;
      }
      const start = plan.tool ? { type: 'tool_use', id: block.id, name: block.name, input: {} } : { type: 'text', text: '' };
      const delta = plan.tool ? { type: 'input_json_delta', partial_json: JSON.stringify(plan.input) } : { type: 'text_delta', text: plan.text };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const [event, data] of [
        ['message_start', { type: 'message_start', message }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: start }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }],
        ['message_stop', { type: 'message_stop' }],
      ]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    /** The Messages requests, in order. */
    messages: () => requests.filter((r) => r.method === 'POST' && r.path === '/v1/messages'),
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

/** A loopback HTTP proxy that records each request it is asked to make (a CONNECT's target, or a plain request's URL)
 *  and refuses all of them: what an agent would reach beyond loopback, seen and never reached. */
export async function recordingProxy() {
  const asked = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/') { res.writeHead(404); res.end(); return; }
    asked.push({ method: req.method, target: req.url });
    res.writeHead(403);
    res.end();
  });
  server.on('connect', (req, socket) => {
    asked.push({ method: 'CONNECT', target: req.url });
    socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    asked,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
