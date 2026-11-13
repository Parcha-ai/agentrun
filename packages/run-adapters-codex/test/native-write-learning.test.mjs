// Codex's own apply_patch never writes in a run's folder, its notes folder (.learning/) included, whatever the turn: the
// end-of-run turn that asks for the run's notes runs on the same session, built-ins off. That holds even when Codex's
// bundled model catalog cannot be read, so apply_patch stays LISTED to the model (catalog.ts): it has no environment to
// run in, and Codex refuses it. The host's gate refuses the host's write and edit under .learning/ in that turn; this
// pins the native side, which no gate sees. The pinned binary, through the adapter, its catalog read refused by the
// host's confinement (as a binary that gives none would), a scripted Responses provider behind the session's proxy. No
// network.
//
// Without the binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing or different binary fails.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const required = env.AGENTRUN_CODEX_REQUIRE_BINARY === '1';
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-learning-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const sse = (n, items) => [
  { type: 'response.created', response: { id: `resp_${n}` } },
  ...items.map((item) => ({ type: 'response.output_item.done', item })),
  { type: 'response.completed', response: { id: `resp_${n}`, usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const say = (n) => ({ type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'done' }] });
const patch = (path) => `*** Begin Patch\n*** Add File: ${path}\n+a note the run wrote itself\n*** End Patch\n`;
/** The host's confinement, refusing Codex's catalog read (`debug models`) and running everything else as given. */
const noCatalog = (child) => ({ command: '/bin/sh', args: ['-c', 'case "$*" in *"debug models"*) echo "no catalog here" >&2; exit 3;; esac; exec "$@"', 'sh', child.command, ...(child.args ?? [])] });

/** One end-of-run-shaped turn on `model`, whose first answer is `attempts`, then submit; what Codex told the model, and
 *  what the run's folder holds. */
async function turn(model, attempts) {
  const dir = mkdtempSync(join(ROOT, 'run-'));
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const n = seen.length;
    const submit = { type: 'function_call', name: 'submit', arguments: JSON.stringify({ value: { notes: 'none' } }), call_id: 'call_submit' };
    const execSubmit = { type: 'custom_tool_call', name: 'exec', input: "text(JSON.stringify(await tools.submit({ value: { notes: 'none' } })));", call_id: 'call_submit' };
    return new Response(sse(n, n === 1 ? attempts : n === 2 ? [model === CODE_MODE ? execSubmit : submit] : [say(n)]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const logged = [];
  const codex = codexAdapter({ model, provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions'), fetch, confine: noCatalog, log: (message) => logged.push(message) });
  const runNode = createHarnessRunner(codex, { store: memorySessionStore(), timeoutMs: 90_000 });
  const output = await runNode({ kind: 'agent', label: 'reflect', system: ['Say what you learned.'], user: 'What would you keep from this run?', schema: { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'] }, tools: [] });
  const told = new Map();
  for (const body of seen) for (const item of body.input ?? []) if (/_output$/.test(item.type ?? '')) told.set(item.call_id, Array.isArray(item.output) ? item.output.map((o) => o.text ?? '').join('\n') : String(item.output));
  const sessions = join(dir, 'sessions');
  const works = readdirSync(sessions).map((s) => join(sessions, s, 'work'));
  return { output, told, logged, learning: works.filter((work) => existsSync(join(work, '.learning'))), seen };
}

const CLASSIC = 'gpt-5.4-mini';
const CODE_MODE = 'gpt-6-sol';

test("with Codex's catalog unreadable, apply_patch stays listed, and a classic model's apply_patch under .learning/ writes nothing", { skip, timeout: 120_000 }, async () => {
  const r = await turn(CLASSIC, [
    { type: 'custom_tool_call', name: 'apply_patch', input: patch('.learning/injected.md'), call_id: 'call_patch' },
    { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: patch('.learning/injected-fn.md') }), call_id: 'call_patch_fn' },
  ]);
  assert.ok(r.logged.some((message) => /apply_patch stays listed/.test(message)), `the catalog could not be read: ${JSON.stringify(r.logged)}`);
  assert.deepEqual(r.output, { notes: 'none' });
  assert.match(r.told.get('call_patch') ?? '', /unsupported custom tool call: apply_patch/);
  assert.match(r.told.get('call_patch_fn') ?? '', /unsupported call: apply_patch/);
  assert.deepEqual(r.learning, [], 'no .learning/ in the run folder');
});

test("with Codex's catalog unreadable, a code-mode model's exec calling apply_patch under .learning/ writes nothing", { skip, timeout: 120_000 }, async () => {
  const r = await turn(CODE_MODE, [
    { type: 'custom_tool_call', name: 'exec', input: `text(String(await tools.apply_patch(${JSON.stringify(patch('.learning/injected.md'))})));`, call_id: 'call_exec_patch' },
  ]);
  assert.ok(r.logged.some((message) => /apply_patch stays listed/.test(message)), `the catalog could not be read: ${JSON.stringify(r.logged)}`);
  assert.deepEqual(r.output, { notes: 'none' });
  assert.doesNotMatch(r.told.get('call_exec_patch') ?? '', /Success|Updated the following files/, `apply_patch did not run: ${r.told.get('call_exec_patch')}`);
  assert.deepEqual(r.learning, [], 'no .learning/ in the run folder');
});
