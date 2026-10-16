// The issue-triage demo as an interactive session, scripted ($0): an agent in a pi-durable-agent home authors, saves, learns and runs the workflow with the agentrun tool; the host
// proposes what the run saved, the curator admits it as a trial, and the next run starts with it in its store.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorPrompt, runSessionDemo, WHEN } from './issue-triage/agent-session.mjs';

const git = (gitDir, ...args) => execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: gitDir } });

test('run 1: the agent describes, inspects, dry-runs, saves, learns when to use the workflow, and runs it; every tool answered', { timeout: 300_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'triage-session-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = await runSessionDemo({ dir: root });
  const { run1, run2 } = out;
  assert.deepEqual(run1.calls.map((c) => c.action ?? `${c.name} ${c.type}`), ['describe', 'inspect', 'dry-run', 'save', 'learn workflow', 'run']);
  assert.deepEqual(run1.results.filter((r) => r.isError), [], 'no tool call of the session failed');
  assert.equal(JSON.parse(run1.results[2].text).dryRun.status, 'passed');
  assert.deepEqual([run1.counts.research, run1.counts.judge, Object.values(run1.counts.tools).reduce((a, b) => a + b, 0)], [20, 20, 80], 'twenty issues: one research node, one Jev request and four tool calls each');
  assert.match(run1.results.at(-1).text, /"status":"complete"/);
  assert.match((await authorPrompt()), /\*\*Describe\*\* the workflow you will build/);

  // The host handed the saved workflow over with the proposal, and the curator admitted it as a trial.
  assert.deepEqual(run1.collected.found.map((w) => w.name), ['issue-triage']);
  assert.equal(run1.proposal.status, 'proposed');
  const accepted = out.curated.runs[0];
  assert.deepEqual([accepted.accepted.length, accepted.held.length, accepted.refused.length], [1, 0, 0]);
  const files = git(out.bare, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(files.some((f) => /^\.agents\/skills\/issue-triage\/SKILL\.md$/.test(f)) || files.some((f) => /issue-triage\/SKILL\.md$/.test(f)), files.join(','));
  assert.ok(files.some((f) => /issue-triage\/trial\.json$/.test(f)));
  assert.ok(files.some((f) => /issue-triage\/[0-9a-f]{64}\.json$/.test(f)));
  assert.match(git(out.bare, 'show', `main:${files.find((f) => /SKILL\.md$/.test(f))}`), new RegExp(WHEN.slice(0, 30)));

  // Run 2 starts with it: seeded into its store, loaded by name, run, and nothing new to propose.
  assert.deepEqual(run2.hints, [{ name: 'issue-triage', status: 'trial' }]);
  assert.deepEqual(run2.calls.map((c) => c.action), ['load', 'run']);
  assert.deepEqual(run2.results.filter((r) => r.isError), []);
  assert.deepEqual([run2.counts.research, run2.counts.judge], [20, 20]);
  assert.equal(run2.proposal.status, 'empty');
  // The vault value is nowhere in the agent's repository.
  assert.throws(() => git(out.bare, 'grep', '-q', out.vault[0], 'main'), (error) => error.status === 1, 'git grep finds nothing');
});
