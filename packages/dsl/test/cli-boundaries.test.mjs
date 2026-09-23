import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const invoke = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000 });
const workflow = {
  v: 2, name: 'cli-boundary', schemas: { Result: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } },
  output: { schemaId: 'Result', path: 'result' },
  root: { node: 'code', label: 'increment', code: 's => ({ result: { count: s.count + 1 } })' },
};

test('CLI refuses untrusted validate, dry-run and run before opening any workflow', () => {
  for (const command of ['validate', 'dry-run', 'run']) {
    const result = invoke([command, '/missing-untrusted-workflow.json', '/missing-input.json']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--trusted/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
    assert.equal(result.stdout, '');
  }
});

test('CLI gives failure exits for malformed JSON, invalid workflow and dry-run execution errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-cli-'));
  try {
    const path = join(dir, 'workflow.json');
    await writeFile(path, '{ invalid');
    let result = invoke(['validate', path, '--trusted']);
    assert.equal(result.status, 1, result.stderr);
    assert.notEqual(result.stderr.trim(), '');
    assert.equal(result.stdout, '');
    await writeFile(path, JSON.stringify({ ...workflow, v: 1 }));
    result = invoke(['validate', path, '--trusted']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
    await writeFile(path, JSON.stringify({ ...workflow, root: { node: 'code', label: 'explode', code: 's => { throw new Error("context.invalid"); }' } }));
    result = invoke(['dry-run', path, '--trusted']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI distinguishes deterministic completion from escalation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-cli-'));
  try {
    const path = join(dir, 'workflow.json'), input = join(dir, 'input.json');
    await writeFile(path, JSON.stringify(workflow));
    await writeFile(input, JSON.stringify({ count: 2, review: true }));
    let result = invoke(['run', path, input, '--trusted']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'complete');
    assert.deepEqual(JSON.parse(result.stdout).output, { count: 3 });
    await writeFile(path, JSON.stringify({ ...workflow, root: { node: 'chain', steps: [
      { node: 'escalate', label: 'review', when: { predicate: 'field_true', path: 'review' }, kind: 'review', stage: 'check', summary: 'Requires human review' }, workflow.root,
    ] } }));
    result = invoke(['run', path, input, '--trusted']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'escalated');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI creates an example once and refuses to overwrite existing bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-cli-'));
  try {
    const path = join(dir, 'example.json');
    let result = invoke(['example', path]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).v, 2);
    await writeFile(path, 'User-owned contents must survive.\n');
    result = invoke(['example', path]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /EEXIST/);
    assert.equal(await readFile(path, 'utf8'), 'User-owned contents must survive.\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('demo rejects misspelled options, positional scenarios and incomplete scenario selections without running billing', () => {
  const invalid = [
    ['ambiguous'], ['technical'], ['--scenario'], ['--scenario', '--json'],
    ['--scenairo', 'ambiguous'], ['--unknown'], ['--scenario', 'unknown'],
    ['--scenario', 'ambiguous', 'extra'], ['--scenario', 'ambiguous', '--scenario', 'billing'],
  ];
  for (const args of invalid) {
    const result = invoke(['demo', ...args]);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '', 'invalid arguments must not execute or print a default scenario');
    assert.match(result.stderr, /scenario|Unexpected demo argument/);
  }
});

test('demo preserves explicit scenarios, the billing default and JSON flag ordering', () => {
  for (const [args, scenario, status] of [
    [['--json'], 'billing', 'complete'],
    [['--scenario', 'billing', '--json'], 'billing', 'complete'],
    [['--json', '--scenario', 'technical'], 'technical', 'complete'],
    [['--scenario', 'ambiguous', '--json'], 'ambiguous', 'escalated'],
  ]) {
    const result = invoke(['demo', ...args]);
    assert.equal(result.status, 0, result.stderr);
    const demo = JSON.parse(result.stdout);
    assert.equal(demo.scenario, scenario);
    assert.equal(demo.result.status, status);
  }
});

test('the demo save hint executes from source without a globally installed command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-cli-hint-'));
  try {
    const result = spawnSync(process.execPath, [cli, 'demo'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const hint = result.stdout.match(/Save this workflow: (.+)/)?.[1];
    assert.ok(hint, result.stdout);
    assert.match(hint, /^node '.+' example workflow\.json$/);
    // Run the exact printed command with the current Node directory on PATH; no
    // globally installed agentrun executable is needed in the clean working directory.
    const saved = spawnSync('/bin/sh', ['-c', hint], {
      cwd: dir, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${join(process.execPath, '..')}:${process.env.PATH}` },
    });
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(JSON.parse(await readFile(join(dir, 'workflow.json'), 'utf8')).name, 'support-triage');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
