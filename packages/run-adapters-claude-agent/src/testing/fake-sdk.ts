// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-claude-code/test/fake-sdk.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, patches: 006-fake-sdk-script, 012-fake-sdk-lists-tools, 014-fake-sdk-system-prompt
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ClaudeAgentSdk } from '../harness.js';

/**
 * A scripted stand-in for the Agent SDK, for tests that need no network: it
 * behaves like `query()` with the `claude` CLI behind it, closely enough to
 * exercise the harness's mirror, tool bridge, barrier, inbox and recovery.
 *
 * - A user message `call <tool> <json args>` makes one tool call through the
 *   harness's MCP server (keyed by a `toolu_<n>` id, as Claude Code does),
 *   then a reply quoting the result. Anything else is echoed.
 * - Every transcript line is mirrored to the session store, the assistant
 *   entry that makes a call `mirrorLagMs` after the call starts (the real
 *   mirror trails the tool by about 100 ms).
 * - Like the SDK, it starts its "CLI" through `spawnClaudeCodeProcess` with
 *   `pathToClaudeCodeExecutable` as the command (the tests give node there:
 *   a stand-in child that lives until its stdin closes), so the session's
 *   machine runs it.
 * - A resume loads the transcript from the store and, like the CLI, answers
 *   a dangling tool_use with a synthetic "interrupted" result.
 * - `exit-during <tool> <json args>` starts the call and exits at once (the
 *   CLI dying mid-call), leaving the handler running.
 * - A message sent at priority `next` while a call runs is folded into that
 *   turn (one result consumes both), as Claude Code does with a steer, and
 *   mirrored as the CLI does: a `queued_command` attachment naming its uuid.
 * - With `remoteModel`, what it says is a model request, as the CLI's is: a
 *   streamed Messages API POST, made by the "CLI" child itself (the runner),
 *   so the relay's model port sees the process the attach spawned as its
 *   caller, to `ANTHROPIC_BASE_URL` (the VM's model port,
 *   to the drive's gateway handler, in front of `fake-anthropic.ts`) with
 *   `ANTHROPIC_AUTH_TOKEN` as its bearer key, asking the model to say it
 *   (an echoing fake says it back), the text deltas yielded as
 *   `stream_event` deltas as they arrive.
 * - With the harness's hooks (built-ins on), `builtin <Name> <json args>` is a
 *   built-in call: `PreToolUse` first (no decision is a deny, as in
 *   `dontAsk`), then the tool, then `PostToolUse` / `PostToolUseFailure`.
 *   `Bash` runs its command the way Claude Code does: a `bash -c` in a
 *   process group of its own, started by the "CLI" child (a small runner,
 *   so it has the CLI's environment and outlives it); `Write` and `Read` act
 *   on the working directory. `exit-during-builtin <Name> <json>` starts the
 *   call and exits at once (the CLI dying mid-call).
 * - `mirror-error` yields the SDK's `system/mirror_error` (a dropped mirror
 *   batch), then answers as usual.
 */

interface FakeTool {
  name: string;
  handler: (args: unknown, extra: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

export interface FakeSdkOptions {
  mirrorLagMs?: number;
  /** A built-in started (`Bash`: the pid of its command's shell, the leader of its own group). */
  onBuiltin?: (call: { id: string; name: string; pid?: number }) => void;
  /** How long a tool call's handler is given before the fake carries on (never: it waits). */
  onQuery?: (options: Record<string, any>) => void;
  /** Called with each user message the fake consumes. */
  onMessage?: (message: { uuid: string; text: string; priority?: string }) => void;
  /**
   * Called once per `query()` with the system prompt it sends, by the CLI's snapshot rule (`sentSystemPrompt`).
   */
  onSystem?: (system: { sessionId: string; resumed: boolean; snapshot: boolean; sent: string }) => void;
  /** Stream what it says from the model behind `ANTHROPIC_BASE_URL` (see above). */
  remoteModel?: boolean;
  /**
   * Commands, one per user message the fake consumes, in place of the message's text: a runner sends its own prompts
   * (the node's, then a nudge), so a test scripts what the "model" does instead. Past the end, the message's text.
   */
  script?: readonly string[];
  /** Each `PreToolUse` decision a built-in got (with the input the hook rewrote, if it did). */
  onDecision?: (call: { id: string; name: string; decision: string; updatedInput?: Record<string, unknown>; reason?: string }) => void;
}

/**
 * The fake "CLI" child in built-ins or remote-model mode. Each
 * `{ id, command, cwd }` line from stdin it runs as Claude Code runs a Bash
 * command, a `bash -c` in a process group of its own (detached) with this
 * process's environment, and reports `{ id, started }` and
 * `{ id, code, stdout, stderr }`. Each `{ id, say: { url, model, text,
 * authorization } }` it sends as the CLI sends a model request (a streamed
 * Messages API POST from this process), reporting `{ id, delta }` per text
 * delta and then `{ id, end: true }` or `{ id, error }`. Exits when its stdin
 * closes (the SDK closing the CLI), leaving any command running.
 */
const RUNNER = `
const { spawn } = require('node:child_process');
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (r) => process.stdout.write(JSON.stringify(r) + '\\n');
async function say(id, { url, model, text, authorization }) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization }, body: JSON.stringify({ model, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: text }] }) });
    if (!res.ok || !res.body) throw new Error('the model answered ' + res.status);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let at = buffer.indexOf('\\n\\n'); at >= 0; at = buffer.indexOf('\\n\\n')) {
        const event = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = event.split('\\n').find((l) => l.startsWith('data: '));
        if (!data) continue;
        const ev = JSON.parse(data.slice(6));
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') out({ id, delta: ev.delta.text || '' });
        if (ev.type === 'message_stop') return out({ id, end: true });
      }
    }
    out({ id, end: true });
  } catch (err) {
    out({ id, error: String((err && err.message) || err) });
  }
}
rl.on('line', (line) => {
  const { id, command, cwd, say: request } = JSON.parse(line);
  if (request) return void say(id, request);
  const p = spawn('/bin/bash', ['-c', command], { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => (stdout += d));
  p.stderr.on('data', (d) => (stderr += d));
  process.stdout.write(JSON.stringify({ id, started: p.pid }) + '\\n');
  p.on('exit', (code) => process.stdout.write(JSON.stringify({ id, code: code ?? 1, stdout, stderr }) + '\\n'));
});
rl.on('close', () => process.exit(0));
`;

/** The fake "CLI" with built-ins off: it lives until its stdin closes (the SDK closing the CLI). */
const IDLE = `process.stdin.on('data', () => {}).on('end', () => process.exit(0))`;

export interface FakeSdk extends ClaudeAgentSdk {
  queries: Record<string, any>[];
  /** Each query's `tools/list` answer from the session's MCP server, as the CLI would read it. */
  listed: { name: string; description?: string; inputSchema: unknown }[][];
}

/** The session's tools, read the way the CLI reads them: an MCP client over a linked in-memory pair, on the harness's server. */
async function sessionTools(instance: any, listed: FakeSdk['listed']): Promise<Map<string, FakeTool>> {
  if (!instance?.server) return new Map((instance?.tools ?? []).map((t: FakeTool) => [t.name, t]));
  const [{ Client }, { InMemoryTransport }] = await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/inMemory.js')]);
  const [client, server] = InMemoryTransport.createLinkedPair();
  await instance.connect(server);
  const mcp = new Client({ name: 'fake-cli', version: '1.0.0' });
  await mcp.connect(client);
  const { tools } = await mcp.listTools();
  listed.push(tools);
  return new Map(
    tools.map((t) => [t.name, { name: t.name, handler: async (args: unknown, extra: any) => (await mcp.callTool({ name: t.name, arguments: args as Record<string, unknown>, _meta: extra?._meta })) as any }]),
  );
}

/**
 * Each session's recorded system prompt. The CLI keeps it with the session, which it keys by project (its cwd) and
 * session id, so it outlives one fake's process; keyed the same way here, two tests share a record only if they share
 * a cwd and a session.
 */
const recordedPrompts = new Map<string, string>();

/**
 * The system prompt a launch sends, by the CLI's snapshot rule (measured on the real CLI, Agent SDK 0.3.286, in five
 * cases: a later launch's own append dropped under a record; sent fresh with `snapshot: false`; a first or resumed
 * launch with snapshot on recording its prompt when the session has none; a `false` launch recording nothing): with
 * snapshot on (or omitted), the session's record, made from this launch's prompt if there is none yet; with it off,
 * this launch's own prompt, recorded nowhere.
 */
export function sentSystemPrompt(records: Map<string, string>, session: string, text: string, snapshot: boolean): string {
  if (!snapshot) return text;
  if (!records.has(session)) records.set(session, text);
  return records.get(session)!;
}

/** The text of a `systemPrompt` option: a preset's name, a custom prompt, then the append. */
function systemText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (!prompt || typeof prompt !== 'object') return '';
  const p = prompt as { type?: string; preset?: string; prompt?: string | string[]; append?: string };
  const custom = p.prompt === undefined ? [] : Array.isArray(p.prompt) ? p.prompt : [p.prompt];
  return [p.type === 'preset' ? `<preset ${p.preset}>` : '', ...custom, p.append ?? ''].filter(Boolean).join('\n\n');
}

export function fakeSdk(fake: FakeSdkOptions = {}): FakeSdk {
  const lag = fake.mirrorLagMs ?? 100;
  let scripted = 0;
  const queries: Record<string, any>[] = [];
  const listed: FakeSdk['listed'] = [];
  const sdk = {
    queries,
    listed,
    query({ prompt, options }: { prompt: AsyncIterable<any>; options: Record<string, any> }) {
      queries.push(options);
      fake.onQuery?.(options);
      const store = options.sessionStore;
      const sessionId: string = options.resume ?? options.sessionId;
      {
        const text = systemText(options.systemPrompt);
        const snapshot = (options.systemPrompt as { snapshot?: boolean } | undefined)?.snapshot !== false;
        const sent = sentSystemPrompt(recordedPrompts, `${options.cwd}\0${sessionId}`, text, snapshot);
        fake.onSystem?.({ sessionId, resumed: !!options.resume, snapshot, sent });
      }
      const key = { projectKey: `-fake${options.cwd.replace(/[^A-Za-z0-9]/g, '-')}`, sessionId };
      const tools = sessionTools(options.mcpServers?.hands?.instance, listed);
      tools.catch(() => {});
      const signal: AbortSignal | undefined = options.abortController?.signal;
      let calls = 0;
      let parent: string | undefined;
      const uuid = () => randomUUID();
      const entry = (type: string, body: Record<string, unknown>): { type: string; uuid: string; message: any; [k: string]: unknown } => {
        const e = { type, uuid: uuid(), parentUuid: parent ?? null, sessionId, message: undefined, ...body };
        parent = e.uuid;
        return e;
      };
      const mirror = (entries: unknown[], delay = 0) => {
        const go = () => store.append(key, entries);
        return delay ? new Promise<void>((r) => setTimeout(() => void go().then(r), delay)) : go();
      };
      const hooksOn = !!options.hooks;
      const runner = hooksOn || !!fake.remoteModel;
      // The "CLI" is `pathToClaudeCodeExecutable` (the tests give node there): the runner, or a child that only waits for stdin to close.
      const child = options.spawnClaudeCodeProcess?.({
        command: options.pathToClaudeCodeExecutable ?? process.execPath,
        args: runner ? ['-e', RUNNER] : ['-e', IDLE],
        env: options.env,
        signal: signal ?? new AbortController().signal,
      });
      // The runner's reports: a command's `{ id, started }`, then `{ id, code, stdout, stderr }`; a model request's `{ id, delta }`s, then `{ id, end }` or `{ id, error }`.
      const reports = new Map<string, (r: { code: number; stdout: string; stderr: string }) => void>();
      const started = new Map<string, (pid: number) => void>();
      const said = new Map<string, { delta(text: string): void; end(error?: string): void }>();
      if (runner && child) {
        let buf = '';
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString();
          for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            try {
              const r = JSON.parse(line);
              if (r.started) started.get(r.id)?.(r.started);
              else if (typeof r.delta === 'string') said.get(r.id)?.delta(r.delta);
              else if (r.end || r.error !== undefined) said.get(r.id)?.end(r.error);
              else reports.get(r.id)?.(r);
            } catch {}
          }
        });
      }
      const runBash = (id: string, command: string) => {
        const done = new Promise<{ code: number; stdout: string; stderr: string }>((r) => reports.set(id, r));
        const pid = new Promise<number>((r) => started.set(id, r));
        child!.stdin.write(`${JSON.stringify({ id, command, cwd: options.cwd })}\n`);
        return { done, pid };
      };
      const hook = async (event: string, input: Record<string, unknown>) => {
        for (const m of options.hooks?.[event] ?? [])
          for (const h of m.hooks) {
            const out = await h({ hook_event_name: event, session_id: sessionId, cwd: options.cwd, ...input }, input.tool_use_id, { signal: signal ?? new AbortController().signal });
            if (out?.hookSpecificOutput?.permissionDecision) return out.hookSpecificOutput as { permissionDecision: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> };
          }
        return undefined;
      };
      /** Run a built-in through its hooks. */
      const builtinCall = async (id: string, name: string, input: any, opts: { exitDuring?: boolean } = {}): Promise<{ text: string; isError: boolean } | undefined> => {
        const decision = await hook('PreToolUse', { tool_name: name, tool_input: input, tool_use_id: id });
        fake.onDecision?.({ id, name, decision: decision?.permissionDecision ?? 'none', ...(decision?.updatedInput ? { updatedInput: decision.updatedInput } : {}), ...(decision?.permissionDecisionReason ? { reason: decision.permissionDecisionReason } : {}) });
        if (decision?.updatedInput) input = decision.updatedInput;
        if (decision?.permissionDecision !== 'allow') return { text: decision?.permissionDecisionReason ?? `${name} is not allowed`, isError: true };
        let response: unknown;
        let failure: string | undefined;
        if (name === 'Bash') {
          const run = runBash(id, String(input.command));
          fake.onBuiltin?.({ id, name, pid: await run.pid });
          if (opts.exitDuring) return undefined;
          const r = await run.done;
          if (r.code === 0) response = { stdout: r.stdout.trimEnd(), stderr: r.stderr.trimEnd(), interrupted: false, isImage: false };
          else failure = `Exit code ${r.code}\n${r.stdout}${r.stderr}`.trimEnd();
        } else if (name === 'Write') {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(join(options.cwd, input.file_path), String(input.content));
          response = { type: 'create', filePath: join(options.cwd, input.file_path), content: String(input.content) };
          if (opts.exitDuring) return undefined;
        } else if (name === 'Read') {
          const { readFile } = await import('node:fs/promises');
          try {
            response = { type: 'text', file: { filePath: join(options.cwd, input.file_path), content: await readFile(join(options.cwd, input.file_path), 'utf8') } };
          } catch (err) {
            failure = (err as Error).message;
          }
        } else failure = `No such tool available: ${name}`;
        if (failure !== undefined) {
          await hook('PostToolUseFailure', { tool_name: name, tool_input: input, tool_use_id: id, error: failure });
          return { text: failure, isError: true };
        }
        await hook('PostToolUse', { tool_name: name, tool_input: input, tool_use_id: id, tool_response: response });
        return { text: typeof response === 'object' && response && 'stdout' in response ? String((response as { stdout: string }).stdout) : JSON.stringify(response), isError: false };
      };
      const inbox: any[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      void (async () => {
        for await (const m of prompt) {
          inbox.push(m);
          wake?.();
        }
        ended = true;
        wake?.();
      })();
      const nextMessage = async () => {
        while (!inbox.length && !ended && !signal?.aborted) await new Promise<void>((r) => (wake = r));
        return inbox.shift();
      };

      const delta = (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
      /** Say `text`: one delta, or (remote) a model request whose pieces stream in. */
      async function* speak(text: string): AsyncGenerator<any> {
        if (!fake.remoteModel) {
          yield delta(text);
          return;
        }
        if (!child) throw new Error('fake-sdk: remoteModel needs spawnClaudeCodeProcess: the "CLI" child makes the model request');
        const pieces: string[] = [];
        let over: { error?: unknown } | undefined;
        let wake: (() => void) | undefined;
        const id = uuid();
        said.set(id, {
          delta: (d) => (pieces.push(d), wake?.()),
          end: (error) => ((over = error === undefined ? {} : { error: new Error(error) }), said.delete(id), wake?.()),
        });
        const request = { url: `${options.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, model: String(options.model ?? 'claude-sonnet-4-5'), text, authorization: `Bearer ${options.env.ANTHROPIC_AUTH_TOKEN}` };
        child.stdin.write(`${JSON.stringify({ id, say: request })}\n`);
        for (;;) {
          while (pieces.length) yield delta(pieces.shift()!);
          if (over) break;
          await new Promise<void>((r) => (wake = r));
        }
        if (over.error) throw over.error;
      }

      async function* run(): AsyncGenerator<any> {
        yield { type: 'system', subtype: 'init', tools: [...(await tools).keys()].map((t) => `mcp__hands__${t}`), session_id: sessionId };
        if (options.resume) {
          const loaded: any[] = (await store.load(key)) ?? [];
          parent = loaded.at(-1)?.uuid;
          // The CLI's own repair of a dangling call.
          const last = loaded.findLast((e) => e.type === 'assistant');
          const dangling = last?.message?.content?.find((c: any) => c.type === 'tool_use');
          if (dangling && !loaded.some((e) => e.type === 'user' && e.message?.content?.[0]?.tool_use_id === dangling.id)) {
            await mirror([
              entry('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: dangling.id, is_error: true, content: '[Tool call interrupted]' }] } }),
            ]);
          }
        }
        for (;;) {
          const m = await nextMessage();
          if (!m || signal?.aborted) return;
          const consumed = [m.uuid];
          const text = typeof m.message.content === 'string' ? m.message.content : '';
          fake.onMessage?.({ uuid: m.uuid, text, ...(m.priority ? { priority: m.priority } : {}) });
          parent = undefined;
          const u = { type: 'user', uuid: m.uuid, parentUuid: null, sessionId, message: { role: 'user', content: text } };
          parent = u.uuid;
          await mirror([{ type: 'queue-operation', operation: 'enqueue' }, u]);
          // A note the harness put before the message (the sandbox's: a lost Drive) is not part of the command.
          const command = fake.script && scripted < fake.script.length ? fake.script[scripted++]! : text.replace(/^(?!(?:builtin|exit-during-builtin|exit-during|call) )[^\n]*\n\n/, '');
          const builtin = /^(builtin|exit-during-builtin) (\S+) (.*)$/s.exec(command);
          if (builtin) {
            const id = `toolu_${randomUUID().slice(0, 8)}_${++calls}`;
            const name = builtin[2]!;
            const args = JSON.parse(builtin[3]!);
            const a = entry('assistant', { message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: args }] } });
            yield* speak(`Running ${name}.`);
            yield { type: 'assistant', parent_tool_use_id: null, uuid: a.uuid, session_id: sessionId, message: { content: [{ type: 'text', text: `Running ${name}.` }] } };
            yield { type: 'assistant', parent_tool_use_id: null, uuid: a.uuid, session_id: sessionId, message: a.message };
            const mirrored = mirror([a], lag);
            const result = await builtinCall(id, name, args, { exitDuring: builtin[1] === 'exit-during-builtin' });
            await mirrored;
            // The CLI died mid-call: no result, no reply.
            if (!result || signal?.aborted) return;
            const r = entry('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: result.isError, content: result.text }] } });
            await mirror([r]);
            yield { type: 'user', parent_tool_use_id: null, message: r.message };
            const reply = `${name} returned: ${result.text}`;
            if (fake.remoteModel) yield* speak(reply);
            const b = entry('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
            await mirror([b]);
            yield { type: 'assistant', parent_tool_use_id: null, uuid: b.uuid, session_id: sessionId, message: b.message };
            yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId, user_message_uuids: consumed, queued_turn_count: 0 };
            await mirror([{ type: 'last-prompt' }]);
            continue;
          }
          // The SDK dropped a mirror batch (its session store refused it three times): it says so, and the CLI carries on.
          if (command === 'mirror-error') yield { type: 'system', subtype: 'mirror_error', error: 'the session store refused the batch', key: { projectKey: 'session', sessionId }, uuid: randomUUID(), session_id: sessionId };
          const dying = /^exit-during (\S+) (.*)$/s.exec(command);
          if (dying) {
            const id = `toolu_${randomUUID().slice(0, 8)}_${++calls}`;
            await mirror([entry('assistant', { message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__hands__${dying[1]}`, input: JSON.parse(dying[2]!) } ] } })]);
            yield { type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: { content: [{ type: 'tool_use', id, name: `mcp__hands__${dying[1]}` }] } };
            void tools.then((t) => t.get(dying[1]!)?.handler(JSON.parse(dying[2]!), { _meta: { 'claudecode/toolUseId': id } }));
            return;
          }
          const call = /^call (\S+) (.*)$/s.exec(command);
          if (call) {
            const id = `toolu_${randomUUID().slice(0, 8)}_${++calls}`;
            const name = call[1]!;
            const args = JSON.parse(call[2]!);
            const a = entry('assistant', { message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__hands__${name}`, input: args }] } });
            yield* speak(`Calling ${name}.`);
            yield { type: 'assistant', parent_tool_use_id: null, uuid: a.uuid, session_id: sessionId, message: { content: [{ type: 'text', text: `Calling ${name}.` }] } };
            yield { type: 'assistant', parent_tool_use_id: null, uuid: a.uuid, session_id: sessionId, message: a.message };
            const mirrored = mirror([a], lag);
            const tool = (await tools).get(name);
            const result = tool ? await tool.handler(args, { _meta: { 'claudecode/toolUseId': id } }) : { content: [{ type: 'text', text: `no tool ${name}` }], isError: true };
            await mirrored;
            if (signal?.aborted) return;
            const r = entry('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!result.isError, content: result.content[0]?.text }] } });
            await mirror([r]);
            yield { type: 'user', parent_tool_use_id: null, message: r.message };
            // A steer sent while the call ran is folded into this turn.
            for (let i = inbox.findIndex((x) => x.priority === 'next'); i >= 0; i = inbox.findIndex((x) => x.priority === 'next')) {
              const s = inbox.splice(i, 1)[0];
              consumed.push(s.uuid);
              fake.onMessage?.({ uuid: s.uuid, text: s.message.content, priority: s.priority });
              // As the CLI does: a message taken in mid-turn is a queued_command attachment naming it, not a user entry.
              await mirror([
                { type: 'queue-operation', operation: 'remove', content: s.message.content },
                entry('attachment', { attachment: { type: 'queued_command', prompt: s.message.content, source_uuid: s.uuid } }),
              ]);
            }
            const reply = `${name} returned: ${result.content[0]?.text}${consumed.length > 1 ? ' (and I read your steer)' : ''}`;
            if (fake.remoteModel) yield* speak(reply);
            const b = entry('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
            await mirror([b]);
            yield { type: 'assistant', parent_tool_use_id: null, uuid: b.uuid, session_id: sessionId, message: b.message };
          } else {
            const reply = text.startsWith('[Recovery]') ? 'Recovered from the log.' : `echo: ${text}`;
            yield* speak(reply);
            const b = entry('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
            await mirror([b]);
            yield { type: 'assistant', parent_tool_use_id: null, uuid: b.uuid, session_id: sessionId, message: b.message };
          }
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId, user_message_uuids: consumed, queued_turn_count: 0 };
          await mirror([{ type: 'last-prompt' }]);
        }
      }
      const gen = (async function* () {
        try {
          yield* run();
        } finally {
          child?.stdin.end();
        }
      })();
      return Object.assign(gen, { close: () => void gen.return(undefined) });
    },
  };
  return sdk as unknown as FakeSdk;
}

