// The agent-learn demo, offline: a scripted model and a scripted judge, no key, no network. It checks the story the
// transcript tells against the repository itself.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { guard, renderInbox } from '@parcha/pi-agent-learn';
import { gitRead, ISSUES, proposalStatus, runDemo, TRIAGE_WORKFLOW } from './demo.mjs';

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

test('a correction and a workflow go through the repository: learned, curated, applied, used, retired; a secret reaches no git object', async (t) => {
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
  assert.deepEqual(out.run2.calls.map((c) => (c.name === 'agentrun' ? `agentrun ${c.arguments.action}` : `learn ${c.arguments.type}`)), ['learn used', 'agentrun inspect', 'agentrun save', 'learn workflow']);
  assert.equal(out.run2.calls[0].arguments.id, out.ruleId, 'run 2 marks the rule it used');
  const digest = git('show', 'runs/run-2:inbox/run-2/workflows/triage-crash/latest');
  assert.match(digest, /^[0-9a-f]{64}$/, 'the run proposed the DSL records');
  assert.match(git('show', `runs/run-2:inbox/run-2/workflows/triage-crash/${digest}.json`), /"issues\.label"/);

  // Curation counts the use and admits the workflow as a trial skill, in the DSL's own layout.
  assert.deepEqual(git('diff', '--name-only', out.curate1.main, out.curate2.main).split('\n').sort(), [
    '.agents/skills/triage-crash/SKILL.md', '.agents/skills/triage-crash/trial.json',
    `.pi/agentrun/workflows/triage-crash/${digest}.json`, '.pi/agentrun/workflows/triage-crash/latest', `learnings/${out.ruleId}.md`,
  ].sort());
  assert.match(git('show', `${out.curate2.main}:learnings/${out.ruleId}.md`), /^uses: 1$/m);
  assert.deepEqual(out.curate2.runs[0].used.map((u) => u.id), [out.ruleId]);
  const trialText = git('show', `${out.curate2.main}:.agents/skills/triage-crash/trial.json`);
  const trial = JSON.parse(trialText);
  assert.equal(trial.status, 'trial');
  assert.deepEqual(trial.revisions.map((r) => [r.sha256, r.status, r.run]), [[digest, 'trial', 'run-2']]);
  assert.match(git('show', `${out.curate2.main}:.agents/skills/triage-crash/SKILL.md`), /stack trace/);

  // Retiring takes the rule out after it was used; curation does not bring it back; the trial stays.
  assert.equal(out.retire.status, 'retired');
  assert.equal(git('rev-parse', 'main'), out.retire.main);
  assert.equal(git('rev-parse', `${out.retire.main}^`), out.curate2.main, 'one retire commit');
  assert.deepEqual(out.curate3.runs, [], 'curating again brings nothing back');
  assert.match(git('show', `main:learnings/${out.ruleId}.md`), /^status: retired$/m, 'main keeps the entry, retired');
  assert.equal(git('log', '--format=%H', 'main', '--', `learnings/${out.ruleId}.md`).split('\n').length, 3, 'history keeps every version: added, used, retired');
  assert.equal(git('show', 'main:.agents/skills/triage-crash/trial.json'), trialText, 'the workflow trial is untouched');

  // Run 3 does not see the rule and does not apply it; it is offered the trial, which is in its own workflow store.
  assert.equal(out.run3.run.sha, out.retire.main, 'run 3 starts at the retire commit');
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
  assert.match(transcript, /^ {3}proposed on runs\/run-2 at [0-9a-f]{7}: its notes and triage-crash's DSL records$/m);
  assert.match(transcript, /^5\. Curate counts the use and admits the workflow as a trial skill$/m);
  assert.match(transcript, /^ {3}a git revert of [0-9a-f]{7}, the commit that added it, would conflict: /m);
  assert.match(transcript, /^ {3}curate again: nothing to curate, the rule does not come back; /m);
  assert.match(transcript, /^8\. Run 4 tries to learn a value the host holds as a secret$/m);
  assert.match(transcript, /proposed nothing; the secret \(raw, base64 or hex\) is in 0 of \d+ git objects/);
  assert.doesNotMatch(transcript, new RegExp(secret), 'the transcript never prints the secret');
});

test('run 2\'s propose line and step 5 say what happened when run 2 saves a workflow without saying when to use it, only marks a use, or does nothing', async (t) => {
  const inspect = { call: 'agentrun', args: { action: 'inspect', workflow: TRIAGE_WORKFLOW, input: ISSUES.second.input } };
  const save = { call: 'agentrun', args: { action: 'save', name: 'triage-crash' } };
  const step5 = async (run2) => {
    const lines = [];
    const out = await runDemo({ dir: join(await scratch(t), 'demo'), log: (line) => lines.push(line), run2 });
    const at = lines.findIndex((line) => line.startsWith('5. '));
    return { out, text: lines.slice(at, lines.indexOf('', at)).join('\n'), lines: lines.join('\n') };
  };

  const undescribed = await step5([inspect, save, {}]);
  assert.match(undescribed.text, /^5\. Curate admits the workflow as a trial skill$/m);
  assert.match(undescribed.text, /^ {3}triage-crash has no skill: no learn\(workflow\) said when to use it, so later runs are not offered it$/m);
  assert.doesNotMatch(undescribed.out.run3.learned.join('\n'), /Workflows to try/);

  assert.match(undescribed.lines, /^ {3}proposed on runs\/run-2 at [0-9a-f]{7}: triage-crash's DSL records$/m);

  const used = await step5([{ call: 'learn', args: (context) => ({ type: 'used', id: /- (L-[0-9a-f]{12}) correction/.exec(JSON.stringify(context.messages))[1], text: 'It helped.' }) }, {}]);
  assert.match(used.lines, /^ {3}proposed on runs\/run-2 at [0-9a-f]{7}: its notes$/m);
  assert.match(used.text, /^5\. Curate counts the use$/m);
  assert.match(used.text, /^ {3}run 2 saved no workflow, so there is no trial to admit$/m);

  const none = await step5([{}]);
  assert.match(none.lines, /^ {3}proposed nothing \(empty\)$/m);
  assert.match(none.text, /^5\. Curate changes nothing for run 2$/m);
  assert.match(none.text, /^ {3}run 2 saved no workflow, so there is no trial to admit$/m);
  assert.deepEqual(none.out.run2.savedWorkflows, []);
});

test('a made-up learning id and a note that repeats the issue number are refused at the call; the restated note is proposed', async (t) => {
  const rule = 'In this project an issue whose body has a stack trace is labeled bug and needs-repro.';
  const lines = [];
  const out = await runDemo({
    dir: join(await scratch(t), 'demo'), log: (line) => lines.push(line),
    run1: [
      {},
      { call: 'learn', args: { type: 'correction', text: rule, id: 'L-a4821c9e530b' } },
      { call: 'learn', args: { type: 'correction', text: `Issue 4821: ${rule}` } },
      { call: 'learn', args: { type: 'correction', text: rule } },
      { say: 'bug, needs-repro: the body is a crash trace.' },
    ],
  });
  const [unseeded, repeated, noted] = out.run1.turns[1].results;
  assert.match(unseeded, /^Not noted: L-a4821c9e530b is not a learning you were given; leave id out for a new learning\./, 'an id that names no seeded learning is refused');
  assert.match(repeated, /^Not noted: it repeats data from this case\./, 'the text holds the issue number 4821');
  assert.equal(noted, '[noted 1]');
  assert.equal(out.run1.proposal.status, 'proposed');
  const inbox = gitRead(out.bare, ['show', `${out.run1.proposal.sha}:inbox/run-1.md`]).toString('utf8');
  assert.doesNotMatch(inbox, /4821/, 'neither refused note reaches git');
  assert.match(lines.join('\n'), /^ {3}learn\(correction L-a4821c9e530b\) -> Not noted: L-a4821c9e530b is not a learning you were given/m);
  assert.match(out.run2.learned.join('\n'), /correction: In this project an issue whose body has a stack trace/);
});

test('a refused proposal names each reason and where it hit, never the value', () => {
  const candidates = [{ callId: 'call-1', type: 'correction', text: 'In this project a stack trace means needs-repro.', evidence: [], id: 'L-a4821c9e530b' }];
  const refusals = guard({ role: 'run', runId: 'run-1', files: { 'inbox/run-1.md': renderInbox('run-1', candidates) }, candidates, caseValues: ISSUES.first.values });
  const line = proposalStatus({ status: 'refused', refusals });
  assert.equal(line, 'refused: case_data in inbox/run-1.md; case_data in candidates[0].id');
  assert.doesNotMatch(line, /4821/);
  assert.equal(proposalStatus({ status: 'empty' }), 'empty');
});

test('the command runs offline, prints the story and leaves nothing behind', async (t) => {
  const tmp = await scratch(t);
  const { stdout } = await promisify(execFile)(process.execPath, ['--no-warnings=ExperimentalWarning', join(import.meta.dirname, 'demo.mjs')], {
    env: { PATH: process.env.PATH, TMPDIR: tmp, HOME: tmp },
    timeout: 120_000,
  });
  assert.match(stdout, /^model: scripted \(no key, no network\); judge: scripted$/m);
  assert.match(stdout, /^ {5}- L-[0-9a-f]{12} correction: In this project an issue whose body has a stack trace is labeled bug and needs-repro/m);
  assert.match(stdout, /^git log --oneline main\n {2}[0-9a-f]{7} retire L-[0-9a-f]{12}: the maintainer withdrew the rule$/m);
  assert.deepEqual(await readdir(tmp), [], 'the temporary directory is removed');
});
