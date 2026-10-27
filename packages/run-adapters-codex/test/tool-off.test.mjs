// The pinned Codex binary, through the adapter, with a scripted model that tries every way to run something: a classic
// model calls Codex's built-ins by name, and a code-mode model (luna) uses code mode's own runtime (Node's modules, the
// process, the network, nested built-ins, a sub-agent). Nothing may run, write or spawn; the only tool that runs is the
// host's. No network: the provider is a scripted fetch behind the session's proxy.
//
// Without the binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing or different binary fails.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-adapters';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { checkBinary, codexAdapter } from '@parcha/agentrun-codex';

const binary = checkBinary();
const required = process.env.AGENTRUN_CODEX_REQUIRE_BINARY === '1';
const skip = 'problem' in binary && !required ? binary.problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-off-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test('the pinned Codex binary is present where it is required', { skip: !required && 'not required here' }, () => {
  assert.ok(!('problem' in binary), binary.problem);
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

test("a classic model's every built-in is refused by Codex itself; only the host's tool runs", { skip, timeout: 120_000 }, async () => {
  const r = await attack('gpt-5.4-mini', (dir) => [
    { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', `touch ${join(dir, 'canary-shell')}`] }), call_id: 'call_shell' },
    { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `touch ${join(dir, 'canary-exec')}` }), call_id: 'call_exec' },
    { type: 'custom_tool_call', name: 'apply_patch', input: patch(join(dir, 'canary-patch')), call_id: 'call_patch' },
    { type: 'custom_tool_call', name: 'apply_patch', input: patch('canary-relative'), call_id: 'call_patch_rel' },
    { type: 'local_shell_call', call_id: 'call_local', status: 'completed', action: { type: 'exec', command: ['touch', join(dir, 'canary-local')] } },
    { type: 'function_call', name: 'write_stdin', arguments: JSON.stringify({ session_id: 1, chars: 'x' }), call_id: 'call_stdin' },
    { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: '/etc/hostname' }), call_id: 'call_image' },
    { type: 'function_call', name: 'request_user_input', arguments: JSON.stringify({ questions: [] }), call_id: 'call_input' },
  ], { type: 'function_call', name: 'submit', arguments: JSON.stringify({ value: { answer: 'ok' } }), call_id: 'call_submit' });

  assert.deepEqual(r.output, { answer: 'ok' });
  assert.deepEqual(Object.fromEntries(r.outputs), {
    call_shell: 'unsupported call: shell',
    call_exec: 'unsupported call: exec_command',
    call_patch: 'unsupported custom tool call: apply_patch',
    call_patch_rel: 'unsupported custom tool call: apply_patch',
    call_local: 'aborted',
    call_stdin: 'unsupported call: write_stdin',
    call_image: 'unsupported call: view_image',
    call_input: 'request_user_input is unavailable in Default mode',
  });
  assert.deepEqual([r.canaries, r.work], [[], []], 'nothing was written');
  assert.deepEqual(r.started.map((e) => e.name), ['submit']);
  for (const body of r.seen) assert.deepEqual(body.tools.map((t) => t.name), ['submit'], "the model is offered the host's tools only");
});

test("a code-mode model's runtime has no Node, no process, no network, no shell and no sub-agent; only the host's tool runs", { skip, timeout: 120_000 }, async () => {
  const js = (dir) => [
    `text('import: ' + await import('node:fs').then(() => 'loaded', (e) => 'refused'));`,
    `text('require: ' + typeof require);`,
    `text('process: ' + typeof process);`,
    `text('fetch: ' + typeof fetch);`,
    `text('nested: ' + Object.keys(tools).sort().join(','));`,
    `text('exec_command: ' + typeof tools.exec_command);`,
    `text('spawn: ' + typeof tools.multi_agent_v1__spawn_agent);`,
    `try { await tools.apply_patch(${JSON.stringify(patch(join(dir, 'canary-patch')))}); } catch (e) { text('patch: ' + e.message); }`,
    `try { await tools.apply_patch(${JSON.stringify(patch('canary-relative'))}); } catch (e) { text('patch: ' + e.message); }`,
    `text('mcp: ' + JSON.stringify(await tools.list_mcp_resources({})));`,
  ].join('\n');
  const r = await attack('gpt-5.6-luna', (dir) => [{ type: 'custom_tool_call', name: 'exec', input: js(dir), call_id: 'call_js' }],
    { type: 'custom_tool_call', name: 'exec', input: `text(JSON.stringify(await tools.submit({ value: { answer: 'ok' } })));`, call_id: 'call_js_submit' });

  assert.deepEqual(r.output, { answer: 'ok' });
  const said = r.outputs.get('call_js');
  for (const line of ['import: refused', 'require: undefined', 'process: undefined', 'fetch: undefined', 'exec_command: undefined', 'spawn: undefined', 'mcp: "{\\"resources\\":[]}"']) assert.ok(said.includes(line), `${line} in ${JSON.stringify(said)}`);
  // Codex's own nested tools, pinned: a new one at a version bump is looked at before it ships.
  assert.ok(said.includes('nested: apply_patch,list_mcp_resource_templates,list_mcp_resources,read_mcp_resource,submit'), JSON.stringify(said));
  assert.deepEqual([r.canaries, r.work], [[], []], 'nothing was written');
  assert.deepEqual(r.started.map((e) => e.name), ['submit']);
  assert.match(r.started[0].callId, /^exec-/, 'a nested call reaches the host under its own name');
  for (const body of r.seen) {
    assert.equal(body.tools, undefined);
    const offered = body.input.filter((i) => i.type === 'additional_tools').flatMap((i) => i.tools.flatMap((ns) => ns.tools.map((t) => `${t.type}:${t.name}`)));
    assert.deepEqual(offered, ['custom:exec', 'function:wait'], "the model is offered code mode's carriers only");
  }
});
