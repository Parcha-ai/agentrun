import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
test('CLI documents validation probes and exits 2 for an escalated run', async () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Validate may execute code probes/);
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-pi-cli-'));
  try {
    const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };
    const workflow = { v: 2, name: 'escalation', schemas: { Result: schema }, output: { schemaId: 'Result', path: 'result' }, root: { node: 'chain', steps: [
      { node: 'escalate', label: 'review', when: { predicate: 'field_true', path: 'review' }, kind: 'review', stage: 'check', summary: 'Needs review' },
      { node: 'code', label: 'finish', code: 's => ({ result: { count: 1 } })' },
    ] } };
    await writeFile(join(dir, 'workflow.json'), JSON.stringify(workflow));
    await writeFile(join(dir, 'input.json'), JSON.stringify({ review: true }));
    await writeFile(join(dir, 'pi.config.mjs'), 'export default {model:{},modelRuntime:{},sessionFactory:async()=>{throw new Error("unexpected inference")}};');
    const run = spawnSync(process.execPath, [cli, 'run', '--config', join(dir, 'pi.config.mjs'), join(dir, 'workflow.json'), join(dir, 'input.json')], { encoding: 'utf8' });
    assert.equal(run.status, 2, run.stderr);
    assert.equal(JSON.parse(run.stdout).status, 'escalated');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('offline SDK fixture retains host-reviewed candidate before its explicit run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-pi-example-'));
  try {
    const example = fileURLToPath(new URL('./fixtures/author-candidate.mjs', import.meta.url));
    const run = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("Network is forbidden in offline example")}', example, '--out', dir, '--run'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /offline scripted Pi \(no inference\)/);
    assert.match(run.stdout, /"checks": "structural-and-host"/);
    assert.match(run.stdout, /"fixtureChecks": 3/);
    assert.match(run.stdout, /"count": 3/);
    const { readdir, readFile } = await import('node:fs/promises');
    const [folder] = await readdir(dir);
    const review = JSON.parse(await readFile(join(dir, folder, '001.review.json')));
    assert.equal(review.accepted, true);
    assert.equal(review.checks, 'structural-and-host');
    assert.equal(JSON.parse(await readFile(join(dir, folder, 'result.json'))).status, 'candidate');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Pi CLI validate uses explicit input keys for reachability checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-pi-validate-'));
  try {
    const workflow = {
      v: 2, name: 'needs-input', schemas: { Count: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } },
      output: { schemaId: 'Count', path: 'result' },
      root: { node: 'extract', label: 'count', instructions: 'Read text from JSON.', requires: ['text'], out: 'Count', as: 'result' },
    };
    const file = join(dir, 'workflow.json');
    await writeFile(file, JSON.stringify(workflow));
    const valid = spawnSync(process.execPath, [cli, 'validate', file, '--inputs', 'text'], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    const missing = spawnSync(process.execPath, [cli, 'validate', file, '--inputs', 'other'], { encoding: 'utf8' });
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stdout, /text/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('saved-default config stops without choosing a model when Pi has no saved default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-pi-default-'));
  try {
    const config = fileURLToPath(new URL('../../../examples/pi-config.mjs', import.meta.url));
    const run = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("Unexpected network request")}', config], {
      cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: 'utf8',
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Configure and save a default in Pi first/);
    assert.doesNotMatch(run.stderr, /Unexpected network request/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
