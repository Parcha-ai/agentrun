import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const host = new URL('./fixtures/resume-host.mjs', import.meta.url).pathname;
const call = (name, as) => ({ node: 'call', label: `call-${name}`, via: 'tool', tool: name, args: { query: 'q' }, out: 'ToolResult', as, deadline_s: 5 });
const workflow = {
  v: 2, name: 'Read, judge, read',
  schemas: {
    ToolResult: { type: 'object', required: ['content', 'details'], properties: { content: { type: 'array' }, details: { type: 'object' } } },
    Decision: { type: 'object', required: ['supported'], properties: { supported: { type: 'boolean', description: 'Does the evidence support the claim?' } } },
  },
  output: { schemaId: 'ToolResult', path: 'two' },
  root: { node: 'chain', steps: [call('first', 'one'), { node: 'judge', label: 'check', state: { evidence: '{one}' }, out: 'Decision', as: 'decision' }, call('second', 'two')] },
};
const lines = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
const run = (cwd, command, hang = '') => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [host, cwd, command, hang], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; child.stdout.on('data', d => { out += d; });
  child.on('exit', (code, signal) => resolve({ code, signal, out }));
  child.on('error', reject);
  run.child = child;
});

test('a slash-command run killed mid-run resumes without a second effect', { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-resume-'));
  const ledger = join(cwd, 'ledger.txt');
  try {
    writeFileSync(join(cwd, 'workflow.json'), JSON.stringify(workflow));
    // The first process hangs inside the judge after the first tool answered, and is killed there.
    const first = run(cwd, 'run', 'hang');
    const child = run.child;
    for (let waited = 0; !existsSync(join(cwd, 'armed')); waited += 20) {
      assert.ok(waited < 20_000, 'the judge was never reached');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    child.kill('SIGKILL');
    assert.equal((await first).signal, 'SIGKILL');
    assert.deepEqual(lines(ledger), ['first', 'judge']);
    // A new process continues the same run: the first tool is answered from its receipt, the judge is asked again.
    const resumed = await run(cwd, 'run');
    const result = JSON.parse(resumed.out.trim().split('\n').at(-1));
    assert.equal(result.status, 'complete', resumed.out);
    assert.deepEqual(lines(ledger), ['first', 'judge', 'judge', 'second']);
    // A third run over a finished one starts a new run: every step runs again.
    const again = JSON.parse((await run(cwd, 'run')).out.trim().split('\n').at(-1));
    assert.equal(again.status, 'complete');
    assert.deepEqual(lines(ledger), ['first', 'judge', 'judge', 'second', 'first', 'judge', 'second']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

const lastLine = out => JSON.parse(out.trim().split('\n').at(-1));
const killWhenArmed = async (cwd, command, hang) => {
  rmSync(join(cwd, 'armed'), { force: true });
  const first = run(cwd, command, hang);
  const child = run.child;
  for (let waited = 0; !existsSync(join(cwd, 'armed')); waited += 20) {
    assert.ok(waited < 20_000, 'the host was never armed');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.kill('SIGKILL');
  assert.equal((await first).signal, 'SIGKILL');
};

test('a run bound to other input starts a new run instead of failing to open the old journal', { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-resume-'));
  const ledger = join(cwd, 'ledger.txt');
  try {
    writeFileSync(join(cwd, 'workflow.json'), JSON.stringify(workflow));
    await killWhenArmed(cwd, 'run', 'hang');
    assert.deepEqual(lines(ledger), ['first', 'judge']);
    const changed = lastLine((await run(cwd, 'input {"note":"other"};;run')).out);
    assert.equal(changed.status, 'complete', JSON.stringify(changed));
    // Nothing was answered from the first run's journal: every step ran again.
    assert.deepEqual(lines(ledger), ['first', 'judge', 'first', 'judge', 'second']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a tool call killed in flight is refused as unknown on resume, named in the report, and not repeated', { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-resume-'));
  const ledger = join(cwd, 'ledger.txt');
  try {
    writeFileSync(join(cwd, 'workflow.json'), JSON.stringify(workflow));
    await killWhenArmed(cwd, 'run', 'tool');
    assert.deepEqual(lines(ledger), ['first', 'judge', 'second']);
    const resumed = lastLine((await run(cwd, 'run')).out);
    assert.equal(resumed.status, 'failed');
    assert.equal(resumed.error.code, 'FROZEN_EFFECT_UNKNOWN');
    assert.equal(resumed.uncertain?.length, 1);
    assert.deepEqual(lines(ledger), ['first', 'judge', 'second']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
