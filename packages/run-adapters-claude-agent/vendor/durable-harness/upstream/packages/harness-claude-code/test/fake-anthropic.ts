/**
 * A scripted Anthropic Messages API for the real Claude Code CLI (docs/workspaces.md
 * §11.4, "the restart-on-a-new-sandbox tests"): what `query()` and the pinned
 * `claude` binary talk to in CI, with no key and no network. Grown from
 * `harness-sandbox/probes/claude-code/spawn-and-resume.mjs`'s server.
 *
 * It enforces the structure the real API enforces, and answers a request that
 * breaks it with the real API's 400 (`invalid_request_error`), so a resume
 * that rebuilt a conversation wrong fails here as it would in production:
 *
 * - `messages` is a non-empty array that starts with a `user` message, and
 *   the roles alternate strictly;
 * - every message has content (a non-empty string or block list), except an
 *   optional final assistant message;
 * - every `tool_use` in an assistant message is answered by a `tool_result`
 *   with its id in the very next user message, and every `tool_result`
 *   answers a `tool_use` of the message before it (no dangling calls, no
 *   orphan results);
 * - no `tool_use` id appears twice in the conversation, and no block is
 *   repeated within a message.
 *
 * What it says is the test's `reply` script, per request. Every streamed
 * reply ends with the Gateway's cost in `message_delta`
 * (`provider_metadata.gateway`, P0.18), so the gateway handler's ledger is
 * charged a real figure. Every request is logged (`requests`): method, path,
 * query, header names, `anthropic-beta`, model, and the parsed body; never an
 * authorization header's value.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One content block, as the Messages API carries it. */
export type Block = { type: string; [key: string]: unknown };

/** One message of a request. */
export interface Message {
  role: 'user' | 'assistant';
  content: string | Block[];
}

/** A request as the script sees it. */
export interface FakeRequest {
  method: string;
  path: string;
  query: string;
  /** Header names (lowercase) and values, without `authorization` and `x-api-key`. */
  headers: Record<string, string>;
  /** Whether it carried a bearer or an api key (never the value). */
  authorized: boolean;
  body: Record<string, any>;
  model?: string;
  messages: Message[];
  /** The tool names the request offers. */
  tools: string[];
  /** Every text block (and string content) of the conversation, joined, for scripts that look for a word. */
  text: string;
  /** The last user message's tool results, by tool_use id. */
  results: Record<string, string>;
}

/** What the model says for one request. */
export type FakeReply =
  | { text: string }
  | { tool: { name: string; input: unknown; id?: string }; text?: string }
  | { error: { status: number; type: string; message: string } }
  /** Hold the response open (after `message_start`) until `release` resolves, then say `then`. */
  | { hold: Promise<void>; then: FakeReply };

export interface FakeAnthropicOptions {
  /** The script: what to answer a `POST /v1/messages`. */
  reply: (request: FakeRequest) => FakeReply | Promise<FakeReply>;
  /** The Gateway's cost per response (`gatewayCost`). Default `'0.0001'`. */
  cost?: string;
}

/** What the fake logged of a request, and what it answered. */
export interface LoggedRequest extends Omit<FakeRequest, 'body'> {
  body: Record<string, any>;
  status: number;
  /** Why it was refused (a 400), if it was. */
  refused?: string;
}

export interface FakeAnthropic {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  readonly requests: LoggedRequest[];
  /** The `POST /v1/messages` requests (the model calls), in order. */
  messages(): LoggedRequest[];
  close(): Promise<void>;
}

let toolSeq = 0;

/** The last user message's text (its string content, or its text blocks), without tool results. */
export function lastUserText(r: Pick<FakeRequest, 'messages'>): string {
  const m = [...r.messages].reverse().find((x) => x.role === 'user');
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n');
}

/** Why `messages` breaks the Messages API's structure, or undefined when it doesn't. */
export function structureProblem(all: unknown): string | undefined {
  if (!Array.isArray(all) || all.length === 0) return 'messages: at least one message is required';
  // A system message after the first (Claude Code 2.1.296's environment note, to a model that takes an effort) is the API's own: the rest must still alternate.
  const messages = all.filter((m, i) => !(i > 0 && (m as Message | undefined)?.role === ('system' as Message['role'])));
  const seenToolUse = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Message;
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return `messages.${i}.role: must be user or assistant`;
    if (i === 0 && m.role !== 'user') return 'messages: the first message must use the "user" role';
    if (i > 0 && (messages[i - 1] as Message).role === m.role) return `messages.${i}: roles must alternate between "user" and "assistant"`;
    const last = i === messages.length - 1;
    const blocks = typeof m.content === 'string' ? undefined : m.content;
    const empty = typeof m.content === 'string' ? m.content.length === 0 : !Array.isArray(m.content) || m.content.length === 0;
    if (empty && !(last && m.role === 'assistant')) return `messages.${i}: all messages must have non-empty content except for the optional final assistant message`;
    if (blocks) {
      const keys = new Set<string>();
      for (const b of blocks) {
        const key = JSON.stringify(b);
        if (keys.has(key)) return `messages.${i}: a content block is repeated`;
        keys.add(key);
        if (b.type === 'tool_use') {
          const id = String(b.id);
          if (seenToolUse.has(id)) return `messages.${i}: \`tool_use\` ids must be unique (${id})`;
          seenToolUse.add(id);
        }
      }
    }
    // Every tool_use is answered by the very next message; every tool_result answers the message before it.
    if (m.role === 'assistant' && blocks) {
      const uses = blocks.filter((b) => b.type === 'tool_use').map((b) => String(b.id));
      if (uses.length) {
        const next = messages[i + 1] as Message | undefined;
        const answered = new Set(next && Array.isArray(next.content) ? next.content.filter((b) => b.type === 'tool_result').map((b) => String(b.tool_use_id)) : []);
        const dangling = uses.filter((id) => !answered.has(id));
        if (dangling.length) return `messages.${i + 1}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${dangling.join(', ')}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`;
      }
    }
    if (m.role === 'user' && blocks) {
      const results = blocks.filter((b) => b.type === 'tool_result').map((b) => String(b.tool_use_id));
      if (results.length) {
        const prev = messages[i - 1] as Message | undefined;
        const uses = new Set(prev && Array.isArray(prev.content) ? prev.content.filter((b) => b.type === 'tool_use').map((b) => String(b.id)) : []);
        const orphan = results.filter((id) => !uses.has(id));
        if (orphan.length) return `messages.${i}.content: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${orphan.join(', ')}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`;
      }
    }
  }
  return undefined;
}

function textOf(messages: Message[], system: unknown): string {
  const out: string[] = [];
  const walk = (c: unknown) => {
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c))
      for (const b of c as Block[]) {
        if (typeof b?.text === 'string') out.push(b.text);
        if (b?.type === 'tool_result') walk(b.content);
      }
  };
  for (const m of messages) walk(m.content);
  walk(system);
  return out.join('\n');
}

function resultsOf(messages: Message[]): Record<string, string> {
  const last = messages.at(-1);
  const out: Record<string, string> = {};
  if (last?.role !== 'user' || !Array.isArray(last.content)) return out;
  for (const b of last.content) {
    if (b.type !== 'tool_result') continue;
    const c = b.content;
    out[String(b.tool_use_id)] = typeof c === 'string' ? c : Array.isArray(c) ? (c as Block[]).map((x) => (typeof x.text === 'string' ? x.text : '')).join('') : '';
  }
  return out;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Start the fake on a free loopback port. */
export async function fakeAnthropic(options: FakeAnthropicOptions): Promise<FakeAnthropic> {
  const requests: LoggedRequest[] = [];
  const cost = options.cost ?? '0.0001';
  const sockets = new Set<import('node:net').Socket>();

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String((err as Error)?.message ?? err) } }));
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const text = await body(req);
    let parsed: Record<string, any> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, any>) : {};
    } catch {}
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'authorization' && k !== 'x-api-key').map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
    const messages = (Array.isArray(parsed.messages) ? parsed.messages : []) as Message[];
    const request: FakeRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.search.replace(/^\?/, ''),
      headers,
      authorized: !!(req.headers.authorization || req.headers['x-api-key']),
      body: parsed,
      ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
      messages,
      tools: Array.isArray(parsed.tools) ? parsed.tools.map((t: { name?: string }) => String(t?.name)) : [],
      text: textOf(messages, parsed.system),
      results: resultsOf(messages),
    };
    const logged: LoggedRequest = { ...request, status: 200 };
    requests.push(logged);
    const fail = (status: number, type: string, message: string) => {
      logged.status = status;
      if (status === 400) logged.refused = message;
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_fake_${requests.length}` });
      res.end(JSON.stringify({ type: 'error', error: { type, message } }));
    };

    if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
      const problem = structureProblem(messages);
      if (problem) return fail(400, 'invalid_request_error', problem);
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ input_tokens: Math.ceil(text.length / 4) }));
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') return fail(404, 'not_found_error', `${req.method} ${url.pathname} is not a route here`);
    if (typeof parsed.model !== 'string') return fail(400, 'invalid_request_error', 'model: Field required');
    if (typeof parsed.max_tokens !== 'number') return fail(400, 'invalid_request_error', 'max_tokens: Field required');
    const problem = structureProblem(messages);
    if (problem) return fail(400, 'invalid_request_error', problem);

    let reply = await options.reply(request);
    let held: Promise<void> | undefined;
    if ('hold' in reply) {
      held = reply.hold;
      reply = reply.then;
    }
    if ('error' in reply) return fail(reply.error.status, reply.error.type, reply.error.message);
    const blocks: Block[] = [];
    if ('text' in reply && reply.text) blocks.push({ type: 'text', text: reply.text });
    if ('tool' in reply) blocks.push({ type: 'tool_use', id: reply.tool.id ?? `toolu_fake_${String(++toolSeq).padStart(4, '0')}_${Date.now().toString(36)}`, name: reply.tool.name, input: reply.tool.input });
    const stopReason = 'tool' in reply ? 'tool_use' : 'end_turn';
    const usage = { input_tokens: Math.ceil(text.length / 4), output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const id = `msg_fake_${requests.length}`;
    const metadata = { gateway: { cost, gatewayCost: cost } };

    if (parsed.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_fake_${requests.length}` });
      return void res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: parsed.model, content: blocks, stop_reason: stopReason, stop_sequence: null, usage, provider_metadata: metadata }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_fake_${requests.length}` });
    const ev = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
    if (held) await held;
    blocks.forEach((b, index) => {
      if (b.type === 'text') {
        ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
      } else {
        ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      ev('content_block_stop', { type: 'content_block_stop', index });
    });
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 12 }, provider_metadata: metadata });
    ev('message_stop', { type: 'message_stop' });
    res.end();
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    messages: () => requests.filter((r) => r.method === 'POST' && r.path === '/v1/messages'),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
