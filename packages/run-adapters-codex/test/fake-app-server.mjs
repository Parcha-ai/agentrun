#!/usr/bin/env node
// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-codex/test/fake-app-server.mjs at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, patches: 005-fake-app-server-script, 006-comments
/**
 * A fake `codex app-server --stdio`, for the tests that need no network. It
 * speaks the subset of the protocol the harness uses and keeps a rollout
 * the way Codex does:
 *
 * - `thread/start` names the rollout file (`$CODEX_HOME/sessions/…/
 *   rollout-<ts>-<threadId>.jsonl`) and creates it lazily, at the first turn,
 *   starting with `session_meta`; `thread/resume` finds it by that pattern
 *   and reads it back ("no rollout found" otherwise);
 * - a turn writes `task_started`, the user message (`response_item`) and its
 *   `UserMessage` event with `client_id`, the assistant's messages,
 *   `function_call` before asking for a dynamic tool (`item/tool/call`, which
 *   blocks), `function_call_output` after, and `task_complete`;
 * - `turn/steer` adds a user message to the running turn
 *   (`FAKE_CODEX_STEER=reject` refuses every steer, as Codex does once a
 *   turn has ended);
 * - `thread/inject_items` appends `response_item` lines;
 * - closing stdin mid-turn writes `turn_aborted`, kills the running command
 *   and exits (its VM, or Codex's own shutdown, would take it).
 *
 * Its "model" is a script: `call <tool> <json args>` calls the tool and
 * reports the result (`twice` asks for the same call twice at once); `shell <command>` runs a built-in command the way
 * Codex does (an `exec_command` call in the rollout, `item/started` for a
 * `commandExecution`, an approval request that blocks, then a login shell,
 * `item/completed` with its output);
 * `patch <path> <content>` is a built-in `apply_patch` (a `fileChange` item
 * and its approval); a `[Recovery]` message is acknowledged; anything else
 * is echoed. A message that starts with an `[Environment]` note is read
 * without it. `FAKE_CODEX_TYPE_MS` slows its typing, `FAKE_CODEX_THINK_MS` its
 * model call after a tool returns and before an echo; `FAKE_CODEX_LOG`
 * appends every method it receives to a file. With `FAKE_CODEX_MODEL=remote`
 * what it says is a model request, as Codex's is: a POST to the provider's
 * `base_url` + `/responses` from `config.toml` (the drive's gateway proxy, in
 * front of a scripted model), with the provider's
 * `env_key` as its bearer key, streamed back piece by piece.
 *
 * For the sandbox tier's tests (docs/workspaces.md §11.4 A6) it also plays
 * the parts of Codex the harness relies on there:
 *
 * - `fake-app-server.mjs sandbox … -- <cmd>` is Codex's bubblewrap self-test:
 *   it runs `<cmd>` (`FAKE_CODEX_BWRAP=fail` fails it, as a VM without a
 *   working bwrap does);
 * - a command's environment follows `config.toml`'s
 *   `shell_environment_policy`: `inherit = "core"` (only `HOME`, `LOGNAME`,
 *   `PATH`, `SHELL`, `USER`, `USERNAME`, `TMPDIR`, `TEMP`, `TMP`), less
 *   `exclude`, plus `set`;
 * - a command that fails the way a sandbox denial does (its output says
 *   "Read-only file system", "Permission denied" or "Operation not
 *   permitted") is offered again without the sandbox: a second approval for
 *   the same item, `reason: 'command failed; retry without sandbox?'`, run
 *   again if accepted (Codex 0.160 under `untrusted`);
 * - `stdin <command>` runs a command and then asks to write to its stdin
 *   (`kind: 'writeStdin'`, its own `approvalId`, the command's item id);
 * - `FAKE_CODEX_COMPLETE_MS` delays a built-in's `item/completed` after it
 *   ran;
 * - `compact` writes a `compacted` line (Codex's own summary of the
 *   history), as a compaction does;
 * - a project config (`<cwd>/.codex/config.toml`) is read only when
 *   `config.toml` trusts the cwd, and its `developer_instructions` then show
 *   in every echo (`[project config: …]`);
 * - `FAKE_CODEX_LAG=1` writes a call's `function_call` line only after the
 *   drive answered it (Codex's rollout writer is asynchronous);
 * - `escalate <command>` asks for its approval with `additionalPermissions`;
 * - `tamper shrink` / `tamper replace` truncates or replaces the rollout
 *   file mid-turn (`FAKE_CODEX_TAMPER` does it in every turn);
 * - `turn/interrupt` kills the running command and ends the turn interrupted;
 * - `recall` answers with the code word an earlier message of the thread
 *   ("the code word is …") named, from the rollout it resumed.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const home = process.env.CODEX_HOME;
if (home && process.argv[2] === 'sandbox') {
  // The bubblewrap self-test: run what follows `--`, or fail as a VM without a working bwrap does.
  const { spawnSync } = await import('node:child_process');
  if (process.env.FAKE_CODEX_BWRAP === 'fail') {
    process.stderr.write('bwrap: setting up uid map: Permission denied\n');
    process.exit(1);
  }
  const at = process.argv.indexOf('--');
  const [cmd, ...rest] = at >= 0 ? process.argv.slice(at + 1) : ['true'];
  process.exit(spawnSync(cmd, rest, { stdio: 'inherit' }).status ?? 1);
}
if (!home || process.argv[2] !== 'app-server') {
  process.stderr.write('usage: CODEX_HOME=… fake-app-server.mjs app-server --stdio\n');
  process.exit(2);
}
const typeMs = Number(process.env.FAKE_CODEX_TYPE_MS ?? 2);
const thinkMs = Number(process.env.FAKE_CODEX_THINK_MS ?? 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => send({ method, params });
const methodLog = process.env.FAKE_CODEX_LOG;

let thread; // { id, path, dynamicTools, lines: [] }
let active; // { id, steers: [] }
let ordinal = 0;
let nextReq = 1;
const waiting = new Map();

const write = (type, payload) => {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ordinal: ordinal++, type, payload });
  if (!existsSync(thread.path)) mkdirSync(dirname(thread.path), { recursive: true });
  appendFileSync(thread.path, `${line}\n`);
  thread.lines.push(JSON.parse(line));
};
const ensureMeta = () => {
  if (thread.lines.length > 0 || existsSync(thread.path)) return;
  write('session_meta', { id: thread.id, session_id: thread.id, cwd: thread.cwd, cli_version: 'fake', model_provider: 'gateway', dynamic_tools: thread.dynamicTools });
};
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = `srv-${nextReq++}`;
    waiting.set(id, { resolve, reject });
    send({ id, method, params });
  });

function findRollout(id) {
  const walk = (d) => {
    if (!existsSync(d)) return undefined;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        const found = walk(p);
        if (found) return found;
      } else if (name.startsWith('rollout-') && name.endsWith(`-${id}.jsonl`)) return p;
    }
    return undefined;
  };
  return walk(join(home, 'sessions'));
}

const config = () => readFileSync(join(home, 'config.toml'), 'utf8');
/** The model's base URL (`model_providers.gateway.base_url` in config.toml), for `FAKE_CODEX_MODEL=remote`. */
const modelBase = () => /^base_url = "([^"]+)"/m.exec(config())?.[1];
/** The provider key, as Codex reads it: the env var config.toml's `env_key` names. */
const modelKey = () => process.env[/^env_key = "([^"]+)"/m.exec(config())?.[1] ?? ''] ?? '';
/** The configured model (`model = "…"`). */
const modelId = () => /^model = "([^"]+)"/m.exec(config())?.[1] ?? 'fake';

/** A table of config.toml (`[name]`'s lines up to the next table), as text. */
const table = (name) => {
  const text = `\n${config()}`;
  const at = text.indexOf(`\n[${name}]\n`);
  if (at < 0) return '';
  const body = text.slice(at + name.length + 4);
  const end = body.indexOf('\n[');
  return end < 0 ? body : body.slice(0, end);
};
/** The variables `inherit = "core"` keeps (Codex 0.160's `CORE_VARS`). */
const CORE = new Set(['HOME', 'LOGNAME', 'PATH', 'SHELL', 'USER', 'USERNAME', 'TMPDIR', 'TEMP', 'TMP']);
/** A command's environment, as `shell_environment_policy` makes it: `inherit` (`core` or `all`), less `exclude` (glob patterns, `*` only), plus `set`. */
function commandEnv() {
  const policy = table('shell_environment_policy');
  const inherit = /^inherit = "([^"]+)"$/m.exec(policy)?.[1] ?? 'all';
  const list = /^exclude = \[(.*)\]$/m.exec(policy)?.[1] ?? '';
  const patterns = [...list.matchAll(/"([^"]*)"/g)].map((m) => new RegExp(`^${m[1].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`, 'i'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => (inherit === 'core' ? CORE.has(k) : true) && !patterns.some((p) => p.test(k))));
  const set = table('shell_environment_policy.set');
  for (const m of set.matchAll(/^([A-Za-z_][A-Za-z0-9_]*|"[^"]+") = ("(?:[^"\\]|\\.)*")$/gm)) env[m[1].replace(/^"|"$/g, '')] = JSON.parse(m[2]);
  return env;
}
/** The project config Codex would layer for `cwd`: only when config.toml trusts it. */
function projectConfig(cwd) {
  const trusted = /^trust_level = "trusted"$/m.test(table(`projects.${JSON.stringify(cwd)}`));
  const file = join(cwd ?? '', '.codex', 'config.toml');
  if (!trusted || !cwd || !existsSync(file)) return undefined;
  return /^developer_instructions = "([^"]*)"/m.exec(readFileSync(file, 'utf8'))?.[1] ?? 'present';
}

/** One model request: `text` streamed back from the remote "model", each piece to `onPiece`. */
async function stream(text, onPiece) {
  const res = await fetch(`${modelBase()}/responses`, {
    method: 'POST',
    // What Codex sends on a Responses call (P0.7): its own protocol headers, the provider key as the bearer.
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${modelKey()}`, originator: 'codex_cli_rs', version: '0.160.0', session_id: thread?.id ?? '' },
    body: JSON.stringify({ model: modelId(), input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }], stream: true, store: false }),
  });
  if (!res.ok || !res.body) throw new Error(`the model answered ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
      const data = buffer.slice(0, at).replace(/^data: /, '');
      buffer = buffer.slice(at + 2);
      if (data === '[DONE]') return;
      if (data) onPiece(JSON.parse(data).delta);
    }
  }
  throw new Error('the model stream was cut');
}

async function say(turnId, text) {
  const itemId = `msg_${randomUUID().slice(0, 8)}`;
  notify('item/started', { threadId: thread.id, turnId, item: { type: 'agentMessage', id: itemId, text: '' } });
  const piece = (delta) => notify('item/agentMessage/delta', { threadId: thread.id, turnId, itemId, delta });
  if (process.env.FAKE_CODEX_MODEL === 'remote') await stream(text, piece);
  else
    for (const p of text.match(/[\s\S]{1,12}/g) ?? []) {
      piece(p);
      await sleep(typeMs);
    }
  write('event_msg', { type: 'item_completed', thread_id: thread.id, turn_id: turnId, item: { type: 'AgentMessage', id: itemId, content: [{ type: 'Text', text }] } });
  write('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  notify('item/completed', { threadId: thread.id, turnId, item: { type: 'agentMessage', id: itemId, text } });
}

function userMessage(turnId, clientId, text) {
  write('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  write('event_msg', { type: 'item_completed', thread_id: thread.id, turn_id: turnId, item: { type: 'UserMessage', id: randomUUID(), ...(clientId ? { client_id: clientId } : {}), content: [{ type: 'text', text }] } });
}

/** `FAKE_CODEX_SCRIPT`: a file holding a JSON list of what the "model" does in each turn, in order across processes (the count is kept beside it), in place of the turn's text (a DSL node's text is its state). */
const scripted = () => {
  const file = process.env.FAKE_CODEX_SCRIPT;
  if (!file) return undefined;
  const at = existsSync(`${file}.at`) ? Number(readFileSync(`${file}.at`, 'utf8')) : 0;
  writeFileSync(`${file}.at`, String(at + 1));
  return JSON.parse(readFileSync(file, 'utf8'))[at];
};

async function runTurn(turnId, clientId, text) {
  ensureMeta();
  write('event_msg', { type: 'task_started', turn_id: turnId });
  userMessage(turnId, clientId, text);
  notify('turn/started', { threadId: thread.id, turn: { id: turnId, status: 'inProgress', items: [] } });
  let last;
  const trimmed = (scripted() ?? text).trim().replace(/^\[Environment\][^\n]*\n\n/, '');
  const escalate = /^escalate\s+([\s\S]+)$/.exec(trimmed);
  const stdin = /^stdin\s+([\s\S]+)$/.exec(trimmed);
  const shell = /^shell\s+([\s\S]+)$/.exec(trimmed) ?? escalate ?? stdin;
  const patch = /^patch\s+(\S+)\s+([\s\S]*)$/.exec(trimmed);
  // `FAKE_CODEX_TAMPER=shrink|replace`: every turn tampers (a model under danger-full-access that keeps at it).
  const tamper = /^tamper\s+(shrink|replace)$/.exec(trimmed) ?? (process.env.FAKE_CODEX_TAMPER ? [null, process.env.FAKE_CODEX_TAMPER] : null);
  const lag = process.env.FAKE_CODEX_LAG === '1';
  if (trimmed === 'compact') {
    // Codex's compaction: the history replaced by its summary, then the turn goes on.
    write('compacted', { message: 'Summary of the conversation so far.', replacement_history: thread.lines.filter((l) => l.type === 'response_item' && l.payload?.type === 'message').map((l) => l.payload) });
    last = 'compacted';
    await say(turnId, last);
  } else if (tamper) {
    await say(turnId, 'Tampering.');
    // After the drive's tail has read what is there (it polls every 100 ms): a tamper it can see.
    await sleep(400);
    const { renameSync, truncateSync, writeFileSync } = await import('node:fs');
    if (tamper[1] === 'shrink') truncateSync(thread.path, 10);
    else {
      writeFileSync(`${thread.path}.new`, readFileSync(thread.path));
      renameSync(`${thread.path}.new`, thread.path);
    }
    await sleep(300);
    last = 'tampered';
    await say(turnId, last);
  } else if (trimmed === 'recall') {
    const said = thread.lines.map((l) => JSON.stringify(l.payload ?? {})).join('\n');
    const word = /code word is (\w+)/.exec(said)?.[1];
    last = word ? `the code word is ${word}` : 'no code word';
    await say(turnId, last);
  } else if (shell || patch) {
    await say(turnId, shell ? 'Running it.' : 'Patching.');
    const callId = `call_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const cmd = shell ? shell[1] : `apply_patch <<'PATCH'\n*** Add File: ${patch[1]}\n+${patch[2]}\n*** End Patch\nPATCH`;
    const callLine = () => write('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd, login: true }), call_id: callId });
    if (!lag) callLine();
    const item = shell
      ? { type: 'commandExecution', id: callId, command: `/bin/bash -lc '${cmd}'`, cwd: thread.cwd, status: 'inProgress', commandActions: [{ type: 'unknown', command: cmd }] }
      : { type: 'fileChange', id: callId, changes: [{ path: join(thread.cwd, patch[1]), kind: { type: 'add' }, diff: patch[2] }], status: 'inProgress' };
    notify('item/started', { threadId: thread.id, turnId, item });
    const decision = await request(shell ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval', {
      threadId: thread.id,
      turnId,
      itemId: callId,
      ...(shell ? { kind: 'command', command: item.command, cwd: thread.cwd, commandActions: item.commandActions } : { reason: null, grantRoot: null }),
      ...(escalate ? { additionalPermissions: { fileSystem: { write: ['/'] } }, reason: 'needs to write outside the workspace' } : {}),
    });
    if (lag) callLine();
    let output;
    let done;
    const run = async () => {
      const { spawn } = await import('node:child_process');
      return new Promise((resolve) => {
        // In app-server's own process group: the stand-in's degraded relay kills a session by its children's groups (a VM's cgroup takes setsid'd ones too).
        const p = spawn('/bin/bash', ['-lc', cmd], { cwd: thread.cwd, env: commandEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
        if (active) active.proc = p;
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        p.on('exit', (code) => resolve({ code: code ?? 1, out }));
      });
    };
    if (decision?.decision !== 'accept') {
      output = 'rejected by user';
      done = { ...item, status: 'declined' };
    } else if (shell) {
      let r = await run();
      if (stdin && !active?.interrupted) {
        // Input for the running command: its own callback id, the command's item.
        const typed = await request('item/commandExecution/requestApproval', { threadId: thread.id, turnId, itemId: callId, approvalId: randomUUID(), kind: 'writeStdin', command: item.command, cwd: thread.cwd });
        r = { ...r, out: `${r.out}${typed?.decision === 'accept' ? 'stdin written\n' : 'stdin rejected\n'}` };
      }
      // What a sandbox denial looks like: offered again, without the sandbox.
      if (r.code !== 0 && !active?.interrupted && /Read-only file system|Permission denied|Operation not permitted/.test(r.out)) {
        const again = await request('item/commandExecution/requestApproval', { threadId: thread.id, turnId, itemId: callId, reason: 'command failed; retry without sandbox?', command: item.command, cwd: thread.cwd, commandActions: item.commandActions });
        if (again?.decision === 'accept') r = await run();
      }
      output = `Process exited with code ${r.code}\nOutput:\n${r.out}`;
      done = { ...item, status: r.code === 0 ? 'completed' : 'failed', exitCode: r.code, aggregatedOutput: r.out };
    } else {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(thread.cwd, patch[1]), patch[2]);
      output = `Success. Updated the following files:\nA ${patch[1]}`;
      done = { ...item, status: 'completed' };
    }
    // `FAKE_CODEX_COMPLETE_MS`: the command is done, its report still to come (a crash aimed between them).
    if (process.env.FAKE_CODEX_COMPLETE_MS) await sleep(Number(process.env.FAKE_CODEX_COMPLETE_MS));
    write('response_item', { type: 'function_call_output', call_id: callId, output });
    notify('item/completed', { threadId: thread.id, turnId, item: done });
    if (active?.interrupted) {
      // `turn/interrupt`: the command was killed, and the turn ends there.
      write('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' });
      active = undefined;
      notify('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'interrupted', error: null, items: [] } });
      return;
    }
    last = `${shell ? 'shell' : 'apply_patch'} ${done.status}: ${output.slice(0, 200)}`;
    await sleep(thinkMs);
    await say(turnId, last);
  } else if (trimmed.startsWith('[Recovery]')) {
    last = 'Recovered from the log. I will check the actual state before repeating anything.';
    await say(turnId, last);
  } else {
    const call = /^(call|twice)\s+(\w+)\s*([\s\S]*)$/.exec(trimmed);
    if (call) {
      const [, verb, tool, rawArgs] = call;
      let args = {};
      try {
        args = rawArgs ? JSON.parse(rawArgs) : {};
      } catch {}
      await say(turnId, `Calling ${tool}.`);
      const callId = `call_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      const callLine = () => write('response_item', { type: 'function_call', name: tool, arguments: JSON.stringify(args), call_id: callId });
      if (!lag) callLine();
      notify('item/started', { threadId: thread.id, turnId, item: { type: 'dynamicToolCall', id: callId, tool } });
      const params = { threadId: thread.id, turnId, callId, namespace: null, tool, arguments: args };
      // `twice`: the same call asked again at once, as a redelivery does; both are answered, and the tool answers one.
      const result = verb === 'twice' ? (await Promise.all([request('item/tool/call', params), request('item/tool/call', params)]))[0] : await request('item/tool/call', params);
      if (lag) callLine();
      const out = result.contentItems?.map((c) => c.text).join('') ?? '';
      write('response_item', { type: 'function_call_output', call_id: callId, output: out });
      notify('item/completed', { threadId: thread.id, turnId, item: { type: 'dynamicToolCall', id: callId, tool, status: result.success ? 'completed' : 'failed' } });
      last = `${tool} ${result.success ? 'returned' : 'failed'}: ${out.slice(0, 200)}`;
      // The next model call: steers that arrived meanwhile go into it.
      await sleep(thinkMs);
    } else {
      await sleep(thinkMs);
      last = `echo: ${trimmed}`;
      if (thread.planted) last += ` [project config: ${thread.planted}]`;
    }
    const steers = active?.steers.splice(0) ?? [];
    if (steers.length) last += ` (steered: ${steers.join(' | ')})`;
    await say(turnId, last);
  }
  write('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: last });
  active = undefined;
  notify('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed', error: null, items: [] } });
}

async function handle(m) {
  if (methodLog) appendFileSync(methodLog, `${m.method ?? 'response'}\n`);
  if (m.id != null && m.method == null) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.error) w?.reject(new Error(m.error.message));
    else w?.resolve(m.result);
    return;
  }
  const reply = (result) => send({ id: m.id, result });
  const fail = (code, message) => send({ id: m.id, error: { code, message } });
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize':
      return reply({ userAgent: 'fake-app-server/0', codexHome: home });
    case 'initialized':
      return;
    case 'thread/start': {
      const id = randomUUID();
      const path = join(home, 'sessions', '2026', '10', '06', `rollout-2026-10-06T00-00-00-${id}.jsonl`);
      thread = { id, path, cwd: p.cwd, dynamicTools: p.dynamicTools ?? [], lines: [], planted: projectConfig(p.cwd) };
      return reply({ thread: { id, path }, approvalPolicy: p.approvalPolicy, sandbox: { type: 'readOnly' } });
    }
    case 'thread/resume': {
      const path = findRollout(p.threadId);
      if (!path) return fail(-32600, `no rollout found for thread id ${p.threadId}`);
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      ordinal = lines.length;
      thread = { id: p.threadId, path, cwd: p.cwd, dynamicTools: lines[0]?.payload?.dynamic_tools ?? [], lines, planted: projectConfig(p.cwd) };
      return reply({ thread: { id: p.threadId, path } });
    }
    case 'thread/inject_items': {
      ensureMeta();
      for (const item of p.items ?? []) write('response_item', item);
      return reply({});
    }
    case 'turn/start': {
      if (!thread || p.threadId !== thread.id) return fail(-32600, 'unknown thread');
      const turnId = randomUUID();
      const text = (p.input ?? []).map((i) => i.text ?? '').join('\n');
      active = { id: turnId, steers: [] };
      reply({ turn: { id: turnId, status: 'inProgress', items: [] } });
      return void runTurn(turnId, p.clientUserMessageId, text).catch((err) => {
        // As Codex ends a turn on an error it won't retry (a 4xx from its provider): the error, then the turn, failed.
        process.stderr.write(`turn failed: ${err.message}\n`);
        notify('error', { threadId: thread.id, turnId, error: { message: err.message }, willRetry: false });
        write('event_msg', { type: 'error', message: err.message });
        write('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: null });
        active = undefined;
        notify('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'failed', error: { message: err.message }, items: [] } });
      });
    }
    case 'turn/steer': {
      if (!active || p.expectedTurnId !== active.id || process.env.FAKE_CODEX_STEER === 'reject') return fail(-32600, 'no active turn to steer');
      const text = (p.input ?? []).map((i) => i.text ?? '').join('\n');
      userMessage(active.id, p.clientUserMessageId, text);
      active.steers.push(text);
      return reply({ turnId: active.id });
    }
    case 'turn/interrupt': {
      if (!active || p.turnId !== active.id) return fail(-32600, 'no active turn to interrupt');
      active.interrupted = true;
      if (active.proc?.pid) {
        try {
          process.kill(active.proc.pid, 'SIGKILL');
        } catch {}
      }
      return reply({});
    }
    default:
      return fail(-32601, `fake app-server: ${m.method} not supported`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on('line', (line) => {
  if (line.trim()) void handle(JSON.parse(line));
});
rl.on('close', () => {
  // The client went away mid-turn: Codex aborts the turn and says so, and its running command goes with it.
  if (active && thread) write('event_msg', { type: 'turn_aborted', turn_id: active.id, reason: 'interrupted' });
  if (active?.proc?.pid && process.env.FAKE_CODEX_LINGER !== '1') {
    try {
      process.kill(active.proc.pid, 'SIGKILL');
    } catch {}
  }
  if (process.env.FAKE_CODEX_LINGER === '1') return setInterval(() => {}, 1 << 30);
  process.exit(0);
});
