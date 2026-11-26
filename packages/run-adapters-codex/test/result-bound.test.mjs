// A host tool's result past the host's bound (HOST_RESULT_MAX_CHARS), on the Codex adapter: the kernel's tool bridge,
// which every host tool's result passes on its way to Codex, cuts it there and says so. A skill file of the most a skill
// holds (1 MiB) reaches Codex (the function_call_output in its rollout) within the bound,
// ending with the line that says where it was cut, and the host hears the call's end flagged truncated. The stand-in
// app-server (fake-app-server.mjs) only: no network, no binary.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as kernel from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';

process.env.AGENTRUN_CODEX_STANDIN = '1';
const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-bound-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const BOUND = 120_000;
const SKILL_MD = '---\nname: research\ndescription: Read big.md.\n---\nRead big.md.\n';
/** The skill at the most a skill holds: SKILL.md and big.md, 1 MiB in all. */
const BIG = 'x'.repeat(1024 * 1024 - Buffer.byteLength(SKILL_MD));
const SCHEMA = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };

/** The output `name`'s one call reached Codex with (the function_call_output lines of its rollout), and its tool_end. */
async function reached({ tools = [], skills, call, contextWindow }) {
  const dir = mkdtempSync(join(ROOT, 'n-'));
  const script = join(dir, 'script.json');
  writeFileSync(script, JSON.stringify([call, 'call submit {"value":{"answer":"ok"}}']));
  const events = [{ delta: 'ok' }, { delta: '', type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 3 } } }];
  const fetch = async () => new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const adapter = codexAdapter({ model: 'luna-test', provider: { origin: 'https://provider.invalid', credential: () => 'k' }, sessionsDir: join(dir, 'sessions'), standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_MODEL: 'remote', FAKE_CODEX_SCRIPT: script } }, fetch, ...(skills ? { skills } : {}), ...(contextWindow ? { contextWindow } : {}) });
  const heard = [];
  const runNode = kernel.createHarnessRunner(adapter, { store: memorySessionStore(), tools, onEvent: (e) => heard.push(e) });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'bound', system: [], user: 'Go.', schema: SCHEMA, tools: tools.map((t) => t.name) }), { answer: 'ok' });
  const name = /^call (\S+)/.exec(call)[1];
  const files = readdirSync(join(dir, 'sessions'), { recursive: true }).filter((f) => /rollout-.*\.jsonl$/.test(String(f)));
  const all = files.flatMap((f) => readFileSync(join(dir, 'sessions', String(f)), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((l) => l.type === 'response_item' && l.payload?.type === 'function_call_output').map((l) => String(l.payload.output));
  const ended = heard.find((e) => e.type === 'tool_end' && e.name === name);
  assert.equal(ended?.isError, false, all.map((output) => output.slice(0, 200)).join(' | '));
  return { ended, outputs: all.filter((output) => output.startsWith(name === 'delegate' ? '{"answer":"' : 'x')) };
}

/** The text a result past the bound reaches the model as: its start, then the line that says where it was cut. */
function cut(text, whole) {
  assert.ok(text.length <= BOUND, `${text.length} characters, past ${BOUND}`);
  const note = /\n\[cut at (\d+) of (\d+) characters\]$/.exec(text);
  assert.ok(note, `ends with the line that says where it was cut: ${JSON.stringify(text.slice(-80))}`);
  assert.deepEqual([Number(note[2]), text.slice(0, note.index)], [whole.length, whole.slice(0, Number(note[1]))]);
}

test("a skill file of the most a skill holds (1 MiB) reaches Codex cut at the host's bound, saying so, and its end is flagged truncated", async () => {
  const { ended, outputs } = await reached({ skills: [{ name: 'research', files: { 'SKILL.md': SKILL_MD, 'big.md': BIG } }], call: 'call read_skill_file {"skill":"research","path":"big.md"}' });
  assert.ok(outputs.length >= 1, 'the call reached Codex');
  for (const output of outputs) cut(output, BIG);
  assert.equal(ended?.truncated, true);
  assert.equal(kernel.HOST_RESULT_MAX_CHARS, BOUND, 'the kernel states the bound');
});

/** The per-model bound of a 16,384-token window (the kernel's resultMaxChars): a quarter of it at three characters a token. */
const SMALL_MAX = 12_288;
const SMALL_MD = 'x'.repeat(50_000);

test("a model with a 16k window: a 50k result reaches Codex cut to the per-model bound, not the host's, saying why", async () => {
  const { ended, outputs } = await reached({ contextWindow: 16_384, skills: [{ name: 'research', files: { 'SKILL.md': SKILL_MD, 'big.md': SMALL_MD } }], call: 'call read_skill_file {"skill":"research","path":"big.md"}' });
  assert.ok(outputs.length >= 1, 'the call reached Codex');
  for (const output of outputs) {
    assert.ok(output.length <= SMALL_MAX, `${output.length} characters, past ${SMALL_MAX}`);
    assert.match(output, /\n\[kept \d+ of 50000 characters: the result was cut to fit this model's context window\./);
    assert.equal(output.slice(0, 1_000), SMALL_MD.slice(0, 1_000), 'its start kept');
  }
  assert.equal(ended?.truncated, true);
});
