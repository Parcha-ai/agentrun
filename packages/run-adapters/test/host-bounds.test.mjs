// Every host tool the kernel makes itself, its largest result held to the host's result bound (HOST_RESULT_MAX_CHARS),
// which each CLI adapter tells its CLI to pass to the model whole; serve's host-bounds test holds serve's host tools to
// it the same way. Each tool's largest result is made here by the tool's own code, from inputs past every cap it has:
// read_skill_file on a file at the most a skill holds, in lines and in one line; delegate on a child's answer far past
// its cap, and its failure; submit's rejection of a value with more errors than any answer holds. Text that the answer
// must escape (quotes) is used wherever it can grow a result. The kernel's tools are named once (KERNEL_HOST_TOOLS); a
// tool the kernel's source makes that is not among them, or one among them with no largest result here, fails the test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as kernel from '@parcha/agentrun-kernel';
import { fauxAdapter, memorySessionStore } from '@parcha/agentrun-kernel/testing';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-kernel-bounds-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
const call = (tool, args, callId = 'c1') => tool.call(args, { callId, signal: new AbortController().signal });

test("every host tool the kernel makes has its largest result within the host's result bound", { timeout: 120_000 }, async (t) => {
  const bound = kernel.HOST_RESULT_MAX_CHARS;
  assert.equal(typeof bound, 'number', "the kernel states the host's result bound");
  const largest = {};

  // read_skill_file: a file at the most a skill holds (1 MiB), in short lines and in one line, at the longest path a skill
  // may name (five folders of 100 characters).
  const deep = Array.from({ length: 4 }, (_, i) => `${String(i)}${'d'.repeat(99)}`).join('/');
  const names = [`${deep}/${'l'.repeat(100)}`, `${deep}/${'o'.repeat(100)}`];
  const root = join(ROOT, 'skills');
  mkdirSync(join(root, 'big', deep), { recursive: true });
  writeFileSync(join(root, 'big', names[0]), `${'"'.repeat(99)}\n`.repeat(1024 * 1024 / 100 - 1));
  writeFileSync(join(root, 'big', names[1]), '"'.repeat(1024 * 1024 - 1));
  const read = kernel.readSkillFileTool(root, [{ name: 'big', files: names }]);
  const reads = [];
  for (const [path, parts] of [[names[0], [{}, { offset: 2 }, { offset: 1, limit: 100_000 }]], [names[1], [{}, { limit: 1 }]]]) for (const args of parts) reads.push(await call(read, { skill: 'big', path, ...args }));
  assert.ok(reads.every((r) => !r.isError), reads.filter((r) => r.isError).map((r) => r.text).join('; '));
  largest[kernel.READ_SKILL_FILE] = Math.max(...reads.map((r) => r.text.length));

  // delegate: a child whose answer is far past the cap, and one that stops without an answer.
  const answer = { answer: '"'.repeat(400_000), citations: Array.from({ length: 300 }, (_, i) => ({ url: `https://c.example/${i}/${'u'.repeat(2_000)}`, title: '"'.repeat(1_000), quote: '"'.repeat(5_000) })), gaps: Array.from({ length: 300 }, () => '"'.repeat(2_000)) };
  const helper = { name: 'look', description: 'Look.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: 'seen' }) };
  const delegate = (script) => kernel.delegateTool({ agents: { big: { description: 'Answers at length.', system: 'Answer at length.', tools: ['look'] } }, tools: [helper], adapter: fauxAdapter({ script }), store: memorySessionStore(), parentKey: `step:${'k'.repeat(200)}` });
  const delegated = [await call(delegate(() => [{ submit: answer }]), { agent: 'big', task: 'Find it all.' }), await call(delegate(() => [{ fail: 'x'.repeat(10_000) }]), { agent: 'big', task: 'Find it all.' })];
  largest[kernel.DELEGATE_TOOL] = Math.max(...delegated.map((r) => r.text.length));

  // submit: a value with an error at every item and every key, rejected; caught through a tool the session calls.
  const schema = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'integer' } } }, additionalProperties: false };
  const bad = { items: Array.from({ length: 20_000 }, () => '"'.repeat(10)), ...Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`${'"'.repeat(90)}${i}`, 1])) };
  let submit;
  let rejected;
  const probe = { name: 'probe', description: 'Submit the bad value.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => { rejected = await submit.call({ value: bad }, { callId: 'p', signal: new AbortController().signal }); return { text: 'ok' }; } };
  const adapter = fauxAdapter({ script: (spec) => { submit = spec.tools.find((tool) => tool.name === kernel.SUBMIT_TOOL); return [{ call: 'probe' }, { submit: { items: [1] } }]; } });
  const runNode = kernel.createHarnessRunner(adapter, { store: memorySessionStore(), tools: [probe] });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'submit', system: [], user: 'Go.', schema, tools: ['probe'] }), { items: [1] });
  assert.equal(rejected?.isError, true, 'the bad value was rejected');
  largest[kernel.SUBMIT_TOOL] = rejected.text.length;

  t.diagnostic(`bound ${bound}: ${JSON.stringify(largest)}`);
  assert.ok(Array.isArray(kernel.KERNEL_HOST_TOOLS), 'the kernel names the host tools it makes');
  assert.deepEqual(Object.keys(largest).sort(), [...kernel.KERNEL_HOST_TOOLS].sort(), 'every host tool the kernel makes has its largest result here');
  for (const [tool, size] of Object.entries(largest)) assert.ok(size < bound, `${tool}'s largest result is ${size} characters, not under the bound ${bound}`);
  // Every place the kernel's source makes a host tool (a HostTool object, or a function answering one) is one of them.
  const made = files(SRC).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/:\s*HostTool\s*=\s*\{|\)\s*:\s*HostTool\s*\{/g)].map(() => file.slice(SRC.length)));
  assert.equal(made.length, kernel.KERNEL_HOST_TOOLS.length, `the kernel's source makes a host tool in ${made.join(', ')}: name each in KERNEL_HOST_TOOLS and give it a largest result here`);
});
