// The agent-learn demo, offline: a scripted model and a scripted judge, no key, no network. It checks the story the
// transcript tells against the repository itself.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gitRead, runDemo } from './demo.mjs';

const RULE = /In this project an issue whose body has a stack trace is labeled bug and needs-repro/;

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-learn-demo-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function objects(gitDir) {
  const all = gitRead(gitDir, ['cat-file', '--batch-all-objects', '--batch']);
  const out = [];
  for (let at = 0; at < all.length;) {
    const newline = all.indexOf(10, at);
    const size = Number(all.subarray(at, newline).toString('utf8').split(' ')[2]);
    out.push(all.subarray(newline + 1, newline + 1 + size));
    at = newline + 1 + size + 1;
  }
  return out;
}

test('a correction and a workflow go through the repository: learned, curated, applied, reverted; a secret reaches no git object', async (t) => {
  const lines = [];
  const out = await runDemo({ dir: join(await scratch(t), 'demo'), log: (line) => lines.push(line) });
  const git = (...args) => gitRead(out.bare, args).toString('utf8').trim();
  const [seed] = git('rev-list', '--max-parents=0', 'main').split('\n');

  // The agent's own rules say how it learns.
  assert.match(git('show', `${seed}:AGENTS.md`), /When a maintainer corrects you, call learn with type correction and the general rule, then answer again\./);

  // Run 1 is corrected and learns the rule; only curation moves main.
  assert.equal(out.run1.run.sha, seed);
  assert.equal(out.run1.turns.length, 2);
  assert.match(out.run1.turns[0].answer, /^bug: /);
  assert.doesNotMatch(out.run1.turns[0].answer, /needs-repro/, 'the rule cannot be guessed from the issue');
  assert.match(out.run1.turns[1].input, /^Correction from the maintainer: /);
  assert.deepEqual(out.run1.turns[1].calls.map((c) => [c.name, c.arguments.type]), [['learn', 'correction']]);
  assert.match(out.run1.turns[1].answer, /^bug, needs-repro: /);
  assert.equal(out.run1.proposal.status, 'proposed');
  assert.equal(git('rev-parse', 'runs/run-1'), out.run1.proposal.sha, 'the run proposed on its own branch');
  assert.match(git('show', `${out.run1.proposal.sha}:inbox/run-1.md`), RULE);
  assert.equal(git('rev-parse', `${out.curate1.main}^`), seed, 'curation moved main by one commit');
  assert.match(out.ruleId, /^L-[0-9a-f]{12}$/);
  assert.deepEqual(out.curate1.runs.map((r) => [r.run, r.accepted.map((a) => a.id)]), [['run-1', [out.ruleId]]]);
  const entry = git('show', `${out.curate1.main}:learnings/${out.ruleId}.md`);
  assert.match(entry, /^type: correction$/m);
  assert.match(entry, RULE);

  // Run 2's request carries the rule and run 2 applies it; it saves a workflow with the agentrun tool and notes when to use it.
  assert.equal(out.run2.run.sha, out.curate1.main, 'run 2 starts at the new main');
  assert.equal(out.run2.fromRequest, true);
  assert.match(out.run2.learned.join('\n'), new RegExp(`- ${out.ruleId} correction: In this project an issue whose body has a stack trace is labeled bug and needs-repro`));
  assert.match(out.run2.answer, /^bug, needs-repro: /);
  assert.deepEqual(out.run2.calls.map((c) => (c.name === 'agentrun' ? `agentrun ${c.arguments.action}` : `learn ${c.arguments.type}`)), ['agentrun inspect', 'agentrun save', 'learn workflow']);
  const digest = git('show', 'runs/run-2:inbox/run-2/workflows/triage-crash/latest');
  assert.match(digest, /^[0-9a-f]{64}$/, 'the run proposed the DSL records');
  assert.match(git('show', `runs/run-2:inbox/run-2/workflows/triage-crash/${digest}.json`), /"issues\.label"/);

  // Curation admits it as a trial skill, in the DSL's own layout.
  assert.deepEqual(git('diff', '--name-only', out.curate1.main, out.curate2.main).split('\n').sort(), [
    '.agents/skills/triage-crash/SKILL.md', '.agents/skills/triage-crash/trial.json',
    `.pi/agentrun/workflows/triage-crash/${digest}.json`, '.pi/agentrun/workflows/triage-crash/latest',
  ]);
  const trialText = git('show', `${out.curate2.main}:.agents/skills/triage-crash/trial.json`);
  const trial = JSON.parse(trialText);
  assert.equal(trial.status, 'trial');
  assert.deepEqual(trial.revisions.map((r) => [r.sha256, r.status, r.run]), [[digest, 'trial', 'run-2']]);
  assert.match(git('show', `${out.curate2.main}:.agents/skills/triage-crash/SKILL.md`), /stack trace/);

  // A revert takes the rule out; curation does not bring it back; the trial stays.
  assert.equal(out.revert.changed, true);
  assert.equal(out.revert.reverted, out.curate1.main);
  assert.equal(git('rev-parse', 'main'), out.revert.sha);
  assert.deepEqual(out.curate3.runs, [], 'curating again brings nothing back');
  assert.equal(git('ls-tree', '--name-only', 'main', 'learnings/'), '', 'main holds no learning');
  assert.equal(git('log', '--format=%H', 'main', '--', `learnings/${out.ruleId}.md`).split('\n').length, 2, 'history keeps the rule and its revert');
  assert.equal(git('show', 'main:.agents/skills/triage-crash/trial.json'), trialText, 'the workflow trial is untouched');

  // Run 3 does not see the rule and does not apply it; it is offered the trial, which is in its own workflow store.
  assert.equal(out.run3.run.sha, out.revert.sha, 'run 3 starts at the revert');
  assert.equal(out.run3.fromRequest, true);
  assert.doesNotMatch(out.run3.system, RULE, 'nothing in run 3\'s request carries the rule');
  assert.match(out.run3.learned.join('\n'), /Nothing learned yet/);
  assert.match(out.run3.learned.join('\n'), /Workflows to try first for this input: triage-crash \(trial\)\./);
  assert.deepEqual(out.run3.run.workflows.loaded, [{ name: 'triage-crash', sha256: digest }]);
  assert.match(out.run3.answer, /^bug: /);
  assert.doesNotMatch(out.run3.answer, /needs-repro/);

  // Run 4's secret is refused at the call and reaches no git object.
  assert.match(out.run4.results[0], /^Not noted: it holds a value the host keeps secret/);
  assert.equal(out.run4.proposal.status, 'empty');
  assert.equal(git('branch', '--list', 'runs/run-4'), '', 'run 4 has no branch');
  const secret = out.vault[0];
  const needles = [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')].map((s) => Buffer.from(s));
  for (const gitDir of [out.bare, join(out.root, 'host-repo')]) {
    const all = objects(gitDir);
    assert.ok(all.length > 10, `${gitDir} holds the story's objects`);
    assert.equal(all.filter((body) => needles.some((needle) => body.includes(needle))).length, 0, 'the secret is in no git object');
  }

  const transcript = lines.join('\n');
  assert.match(transcript, /^2\. Run 1 starts at main [0-9a-f]{7}: nothing learned yet$/m);
  assert.match(transcript, /^5\. Curate admits the workflow as a trial skill$/m);
  assert.match(transcript, /^8\. Run 4 tries to learn a value the host holds as a secret$/m);
  assert.match(transcript, /proposed nothing; the secret \(raw, base64 or hex\) is in 0 of \d+ git objects/);
  assert.doesNotMatch(transcript, new RegExp(secret), 'the transcript never prints the secret');
});

test('the command runs offline, prints the story and leaves nothing behind', async (t) => {
  const tmp = await scratch(t);
  const { stdout } = await promisify(execFile)(process.execPath, ['--no-warnings=ExperimentalWarning', join(import.meta.dirname, 'demo.mjs')], {
    env: { PATH: process.env.PATH, TMPDIR: tmp, HOME: tmp },
    timeout: 120_000,
  });
  assert.match(stdout, /^model: scripted \(no key, no network\); judge: scripted$/m);
  assert.match(stdout, /^ {5}- L-[0-9a-f]{12} correction: In this project an issue whose body has a stack trace is labeled bug and needs-repro/m);
  assert.match(stdout, /^git log --oneline main\n {2}[0-9a-f]{7} Revert "curate: run run-1/m);
  assert.deepEqual(await readdir(tmp), [], 'the temporary directory is removed');
});
