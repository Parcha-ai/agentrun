// The pinned Codex binary, through the adapter, with a scripted model that tries every way to run something: a classic
// model (one Codex's catalog does not list) calls Codex's built-ins by name; a code-mode model (gpt-6-luna) calls them
// by name and from an exec script. Nothing may run, write or spawn; the only tool that runs is the host's. No network:
// the provider is a scripted fetch behind the session's proxy.
//
// Without the binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing or different binary fails.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';
import { CLASSIC_MODEL, CODEX_NESTED, codeModeOffer, exec, hostNested } from './offer.mjs';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const required = process.env.AGENTRUN_CODEX_REQUIRE_BINARY === '1';
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-off-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test('the pinned Codex binary is present where it is required', { skip: !required && 'not required here' }, () => {
  assert.ok(!problem, problem);
});

const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const sse = (n, items) => [
  { type: 'response.created', response: { id: `resp_${n}` } },
  ...items.map((item) => ({ type: 'response.output_item.done', item })),
  { type: 'response.completed', response: { id: `resp_${n}`, usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const say = (n) => ({ type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'done' }] });

/** Run one node whose model answers `attacks` first, then `submit`, then plain text; report what happened. */
async function attack(model, attacks, submit) {
  const dir = mkdtempSync(join(ROOT, 'run-'));
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const n = seen.length;
    return new Response(sse(n, n === 1 ? attacks(dir) : n === 2 ? [submit] : [say(n)]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const codex = codexAdapter({ model, provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions'), fetch });
  const started = [];
  const runNode = createHarnessRunner(codex, { store: memorySessionStore(), timeoutMs: 90_000, onEvent: (e) => { if (e.type === 'tool_start') started.push(e); } });
  const output = await runNode({ kind: 'agent', label: 'probe', system: ['Answer.'], user: 'Say ok.', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, tools: [] });
  // What Codex told the model about each call, from the request after it.
  const outputs = new Map();
  for (const it of seen[1]?.input ?? []) if (/_output$/.test(it.type ?? '')) outputs.set(it.call_id, Array.isArray(it.output) ? it.output.map((o) => o.text) : it.output);
  const sessions = join(dir, 'sessions');
  const work = readdirSync(sessions).flatMap((s) => readdirSync(join(sessions, s, 'work')));
  return { dir, seen, output, outputs, started, work, canaries: readdirSync(dir).filter((f) => f.startsWith('canary')) };
}

const patch = (path) => `*** Begin Patch\n*** Add File: ${path}\n+pwned\n*** End Patch\n`;

/** Every built-in a model could name at the top level of its answer, each aimed at a canary under `dir`. */
const builtins = (dir) => [
  { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', `touch ${join(dir, 'canary-shell')}`] }), call_id: 'call_shell' },
  { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `touch ${join(dir, 'canary-exec')}` }), call_id: 'call_exec' },
  { type: 'custom_tool_call', name: 'apply_patch', input: patch(join(dir, 'canary-patch')), call_id: 'call_patch' },
  { type: 'custom_tool_call', name: 'apply_patch', input: patch('canary-relative'), call_id: 'call_patch_rel' },
  { type: 'local_shell_call', call_id: 'call_local', status: 'completed', action: { type: 'exec', command: ['touch', join(dir, 'canary-local')] } },
  { type: 'function_call', name: 'write_stdin', arguments: JSON.stringify({ session_id: 1, chars: 'x' }), call_id: 'call_stdin' },
  { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: '/etc/hostname' }), call_id: 'call_image' },
  { type: 'function_call', name: 'request_user_input', arguments: JSON.stringify({ questions: [] }), call_id: 'call_input' },
];
/** What Codex tells the model of each of `builtins`. */
const REFUSED = {
  call_shell: 'unsupported call: shell',
  call_exec: 'unsupported call: exec_command',
  call_patch: 'unsupported custom tool call: apply_patch',
  call_patch_rel: 'unsupported custom tool call: apply_patch',
  call_local: 'aborted',
  call_stdin: 'unsupported call: write_stdin',
  call_image: 'unsupported call: view_image',
  call_input: 'request_user_input is unavailable in Default mode',
};

test("a classic model's every built-in is refused by Codex itself; only the host's tool runs", { skip, timeout: 120_000 }, async () => {
  const r = await attack(CLASSIC_MODEL, builtins, { type: 'function_call', name: 'submit', arguments: JSON.stringify({ value: { answer: 'ok' } }), call_id: 'call_submit' });

  assert.deepEqual(r.output, { answer: 'ok' });
  assert.deepEqual(Object.fromEntries(r.outputs), REFUSED);
  assert.deepEqual([r.canaries, r.work], [[], []], 'nothing was written');
  assert.deepEqual(r.started.map((e) => e.name), ['submit']);
  for (const body of r.seen) assert.deepEqual(body.tools.map((t) => t.name), ['submit'], "the model is offered the host's tools only");
});

/** The built-ins a code-mode script could name on `tools`, each aimed at a canary under `dir`. */
const NESTED = ['exec_command', 'shell', 'shell_command', 'apply_patch', 'write_stdin', 'view_image', 'spawn_agent', 'request_user_input'];
const nestedScript = (dir) => `const tried = [];
const args = { cmd: ${JSON.stringify(`touch ${join(dir, 'canary-nested')}`)}, command: ['touch', ${JSON.stringify(join(dir, 'canary-nested'))}], input: ${JSON.stringify(patch(join(dir, 'canary-nested-patch')))}, path: '/etc/hostname', session_id: 1, chars: 'x', message: 'x', questions: [] };
for (const name of ${JSON.stringify(NESTED)}) {
  try { await tools[name](args); tried.push(name + ': ran'); } catch (e) { tried.push(name + ': ' + String(e && e.message)); }
}
text(tried.join('\\n'));`;

test("a code-mode model (gpt-6-luna) is offered exec and wait only, its built-ins are refused at the top level and absent from the script's tools; only the host's tool runs", { skip, timeout: 120_000 }, async () => {
  const r = await attack('gpt-6-luna', (dir) => [...builtins(dir), exec('call_nested', nestedScript(dir))], exec('call_submit', `text(JSON.stringify(await tools.submit({ value: { answer: 'ok' } })));`));

  assert.deepEqual(r.output, { answer: 'ok' });
  const { call_nested: nested, ...top } = Object.fromEntries(r.outputs);
  assert.deepEqual(top, REFUSED);
  const tried = [nested].flat().join('\n');
  for (const name of NESTED) assert.match(tried, new RegExp(`^${name}: tools\\[name\\] is not a function$`, 'm'), `${name} is not on the script's tools: ${tried}`);
  assert.deepEqual([r.canaries, r.work], [[], []], 'nothing was written');
  assert.deepEqual(r.started.map((e) => e.name), ['submit']);
  for (const body of r.seen) {
    const offer = codeModeOffer(body);
    assert.deepEqual([offer.tools, offer.items, offer.namespace], [undefined, 1, ['exec', 'wait']], 'no top-level tools: one additional_tools item with exec and wait');
    assert.deepEqual(hostNested(body), ['submit'], "the script's tools are the host's and Codex's read-only own");
    assert.deepEqual([...offer.nested.keys()].sort(), [...CODEX_NESTED, 'submit'].sort());
  }
});
