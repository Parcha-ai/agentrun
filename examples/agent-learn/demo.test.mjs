// The agent-learn demo, offline: a scripted model and a scripted judge, no key, no network. It checks the story the
// transcript tells against the repository itself.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { recordingLines } from '@parcha/agentrun-pi/durable';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { admitRevision, guard, parseTrial, readUses, renderInbox, renderTrial, trialPath, usesSettler, workflowAdmitter } from '@parcha/pi-agent-learn';
import { gitRead, ISSUES, proposalStatus, runDemo, runOnce, scriptedModel, TRIAGE_WORKFLOW } from './demo.mjs';

const RULE = /In this project an issue whose body has a stack trace is labeled bug and needs-repro/;

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-learn-demo-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// The default story, run once for the tests that only read it.
let story;
const storyOf = () => (story ??= (async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-learn-demo-test-'));
  try {
    await chmod(dir, 0o755);
    const lines = [];
    return { dir, lines, out: await runDemo({ dir: join(dir, 'demo'), log: (line) => lines.push(line) }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
})());
after(async () => {
  const done = await story?.catch(() => undefined);
  if (done) await rm(done.dir, { recursive: true, force: true });
});

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
  const { out, lines } = await storyOf();
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
  assert.equal(out.curate3.main, out.retire.main, 'curating again moves nothing');
  assert.equal(git('rev-parse', `${out.retire.main}^`), out.curate2.main, 'one retire commit');
  assert.deepEqual(out.curate3.runs, [], 'curating again brings nothing back');
  assert.match(git('show', `${out.retire.main}:learnings/${out.ruleId}.md`), /^status: retired$/m, 'main keeps the entry, retired');
  assert.equal(git('log', '--format=%H', 'main', '--', `learnings/${out.ruleId}.md`).split('\n').length, 3, 'history keeps every version: added, used, retired');
  assert.equal(git('show', `${out.retire.main}:.agents/skills/triage-crash/trial.json`), trialText, 'the workflow trial is untouched');

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

const TRIAL_JSON = '.agents/skills/triage-crash/trial.json';

/** The tool's own records in a finished run's store: its `agentrun.workflow` tasks, as pi-durable committed them. */
const toolTasks = (run) => recordingLines(run.storePath).lines.filter((line) => line.kind === 'agentrun.workflow').map((line) => line.data);

test('a trial is promoted to active on its third clean run, each use read from the records the agentrun tool left in the run\'s own store', async () => {
  const { out } = await storyOf();
  const git = (...args) => gitRead(out.bare, args).toString('utf8').trim();
  const [{ sha256: digest }] = out.run3.run.workflows.loaded;
  const { clean } = out.earned;
  assert.deepEqual(clean.map((r) => r.run.runId), ['run-5', 'run-6', 'run-7']);

  for (const r of clean) {
    const id = r.run.runId;
    // The run ran the saved workflow through the real tool: load it by name, then run it.
    assert.deepEqual(r.calls.map((c) => `${c.name} ${c.arguments.action}`), ['agentrun load', 'agentrun run']);
    assert.equal(JSON.parse(r.results[0]).saved.digest, digest, 'it loaded the revision on main');
    assert.equal(JSON.parse(r.results[1]).outcome.status, 'complete');
    // What the tool left in the store: one workflow task, keyed by the tool, ended complete.
    const [task, ...more] = toolTasks(r.run);
    assert.equal(more.length, 0, 'one task for one run');
    assert.match(task.input.key, /^agentrun:\d+:[0-9a-f]{64}:[0-9a-f]+$/);
    assert.equal(task.state.status, 'terminal');
    assert.equal(task.state.outcome.result.status, 'complete');
    // readUses reads those records, and the run proposed exactly what it read: its use, and nothing else.
    const read = await readUses({ store: r.run.storePath, workDir: r.run.workspace, run: id });
    assert.deepEqual(read.skipped, []);
    assert.deepEqual(read.doc.uses.map((u) => [u.name, u.sha256, u.outcome]), [['triage-crash', digest, 'frozen']]);
    assert.equal(r.proposal.status, 'proposed');
    assert.deepEqual(JSON.parse(git('show', `${r.proposal.sha}:uses/${id}.json`)), read.doc);
    assert.equal(git('diff', '--name-only', `${r.proposal.sha}^`, r.proposal.sha), `uses/${id}.json`);
  }

  // Curation folds each use into trial.json: two holds, then the third frozen use promotes.
  assert.deepEqual(clean.map((r) => r.curate.runs.map((run) => run.settled.map((d) => d.reason.split(':')[0]))), [[['hold']], [['hold']], [['promote']]]);
  assert.match(clean[0].curate.runs[0].settled[0].reason, /has 1 use in its trial; promotion needs its last 3 all frozen$/);
  assert.match(clean[1].curate.runs[0].settled[0].reason, /has 2 uses in its trial; promotion needs its last 3 all frozen$/);
  assert.match(clean[2].curate.runs[0].settled[0].reason, /^promote: its last 3 uses all finished frozen$/);
  assert.deepEqual(clean.map((r) => r.trial.status), ['trial', 'trial', 'active']);
  assert.equal(clean[0].run.sha, out.retire.main, 'run 5 starts where the story left main');
  assert.equal(clean[1].run.sha, clean[0].curate.main, 'each run starts at the commit that counted the one before');
  for (const [i, r] of clean.entries()) {
    assert.equal(git('diff', '--name-only', i ? clean[i - 1].curate.main : out.retire.main, r.curate.main), TRIAL_JSON, 'a use changes trial.json and nothing else');
  }
  const promoted = JSON.parse(git('show', `${clean[2].curate.main}:${TRIAL_JSON}`));
  assert.equal(promoted.status, 'active');
  assert.deepEqual(promoted.revisions.map((r) => [r.sha256, r.status, r.run]), [[digest, 'active', 'run-2']]);
  assert.deepEqual(promoted.uses.map((u) => [u.run, u.sha256, u.outcome]), clean.map((r) => [r.run.runId, digest, 'frozen']));
  assert.equal(JSON.parse(git('show', `${clean[1].curate.main}:${TRIAL_JSON}`)).status, 'trial', 'two clean uses are not enough');
  assert.equal(git('show', `${clean[2].curate.main}:.pi/agentrun/workflows/triage-crash/latest`), digest, 'the skill and the record stay as they were');

  // An active workflow is offered without the trial mark.
  assert.match(out.earned.v2.learned.join('\n'), /^ *Workflows to try first for this input: triage-crash\. Run one with the agentrun tool/m);
  assert.match(out.log, /curate: run run-7: .* 1 settled/);
});

test('a revision that escalates twice in a row is demoted and the one it replaced comes back; the demoted revision never returns', async () => {
  const { out, lines } = await storyOf();
  const git = (...args) => gitRead(out.bare, args).toString('utf8').trim();
  const [{ sha256: first }] = out.run3.run.workflows.loaded;
  const { v2, escalated, again } = out.earned;
  const trialAt = (sha) => JSON.parse(git('show', `${sha}:${TRIAL_JSON}`));

  // Run 8 saves a second revision while the first is active: it is the live trial and the first is kept to restore.
  const second = JSON.parse(v2.results[1]).digest;
  assert.notEqual(second, first);
  assert.deepEqual(v2.curate.runs.map((r) => r.accepted.map((a) => a.workflow)), [['triage-crash']]);
  const afterSecond = trialAt(v2.curate.main);
  assert.equal(afterSecond.status, 'trial');
  assert.deepEqual(afterSecond.revisions.map((r) => [r.sha256, r.status]), [[first, 'superseded'], [second, 'trial']]);
  assert.match(afterSecond.revisions[0].description, /stack trace: it labels the issue bug and needs-repro\.$/, 'the superseded revision keeps its description');
  assert.match(git('show', `${v2.curate.main}:.agents/skills/triage-crash/SKILL.md`), /hands an issue with no body to a person/);

  // Runs 9 and 10 load that revision and the tool's run escalates at its gate; the store's task ended complete with an escalated result.
  assert.deepEqual(escalated.map((r) => r.run.runId), ['run-9', 'run-10']);
  for (const r of escalated) {
    assert.deepEqual(r.calls.map((c) => `${c.name} ${c.arguments.action}`), ['agentrun load', 'agentrun run']);
    assert.equal(JSON.parse(r.results[0]).saved.digest, second, 'the run was offered and loaded the live trial');
    const { outcome } = JSON.parse(r.results[1]);
    assert.equal(outcome.status, 'escalated');
    assert.equal(outcome.escalation.label, 'no body to read');
    const [task] = toolTasks(r.run);
    assert.equal(task.state.outcome.status, 'completed');
    assert.equal(task.state.outcome.result.status, 'escalated');
    const read = await readUses({ store: r.run.storePath, workDir: r.run.workspace, run: r.run.runId });
    assert.deepEqual(read.doc.uses.map((u) => [u.name, u.sha256, u.outcome]), [['triage-crash', second, 'escalated']]);
    assert.deepEqual(JSON.parse(git('show', `${r.proposal.sha}:uses/${r.run.runId}.json`)), read.doc);
  }
  assert.match(escalated[0].curate.runs[0].settled[0].reason, /^hold: /, 'one escalation is not enough');
  assert.equal(escalated[0].trial.status, 'trial');
  assert.equal(escalated[1].curate.runs[0].settled.length, 1);
  assert.equal(escalated[1].curate.runs[0].settled[0].reason, `demote, back to ${first.slice(0, 12)}: its last 2 uses ended escalated, escalated`);

  // The rollback is one commit: the first revision is active again, its description is the skill's, and `latest` names it.
  const rolled = trialAt(escalated[1].curate.main);
  assert.equal(rolled.status, 'active');
  assert.deepEqual(rolled.revisions.map((r) => [r.sha256, r.status]), [[first, 'active'], [second, 'demoted']]);
  assert.deepEqual(git('diff', '--name-only', escalated[0].curate.main, escalated[1].curate.main).split('\n').sort(), [
    '.agents/skills/triage-crash/SKILL.md', TRIAL_JSON, '.pi/agentrun/workflows/triage-crash/latest',
  ].sort());
  assert.equal(git('show', `${escalated[1].curate.main}:.pi/agentrun/workflows/triage-crash/latest`), first);
  const skill = git('show', `${escalated[1].curate.main}:.agents/skills/triage-crash/SKILL.md`);
  assert.match(skill, /stack trace: it labels the issue bug and needs-repro\./);
  assert.doesNotMatch(skill, /no body/);
  assert.match(git('show', `${escalated[1].curate.main}:.pi/agentrun/workflows/triage-crash/${second}.json`), /no body to read/, 'the demoted revision stays in history and on main');

  // The next run is offered the first revision again, as active, and holds it in its own store.
  assert.equal(again.run.sha, escalated[1].curate.main);
  assert.match(again.learned.join('\n'), /^ *Workflows to try first for this input: triage-crash\. Run one with the agentrun tool/m);
  assert.deepEqual(again.run.workflows.loaded, [{ name: 'triage-crash', sha256: first }]);

  // That run saves the demoted document again: the repository already holds its digest, so nothing is proposed and main stays.
  assert.equal(JSON.parse(again.results[1]).digest, second, 'the run saved the demoted revision again');
  assert.equal(again.proposal.status, 'empty');
  assert.deepEqual(again.curate.runs, []);
  assert.equal(again.curate.main, escalated[1].curate.main);
  assert.equal(git('rev-parse', 'main'), escalated[1].curate.main);
  assert.match(lines.join('\n'), /^12\. The demoted revision never returns: run 11 saves it again$/m);

  // And if a proposal for it did reach curation, the admitter refuses it: only a changed document is tried again.
  const read = (path, sha) => { try { return gitRead(out.bare, ['show', `${sha}:${path}`]).toString('utf8'); } catch { return undefined; } };
  const record = read(`.pi/agentrun/workflows/triage-crash/${second}.json`, escalated[1].curate.main);
  const refused = await workflowAdmitter()({
    main: escalated[1].curate.main, read, list: async () => [],
    workflow: { run: 'run-12', name: 'triage-crash', records: { [`${second}.json`]: record, latest: `${second}\n` }, untrusted: false },
  });
  assert.equal(refused.status, 'refused');
  assert.match(refused.reason, /^demoted: [0-9a-f]{12} was demoted; a demoted revision is never tried again$/);
});

test('the tool\'s other records are read the same way: a tool that is down is a failed use, two cases in one run are two records but one use, and a dry run is none', async (t) => {
  const root = await scratch(t);
  const issue = ISSUES.third;
  const steps = (action) => [
    { call: 'agentrun', args: { action: 'load', name: 'triage-crash', input: issue.input } },
    { call: 'agentrun', args: { action } },
    { say: 'bug: the body is a crash trace.' },
  ];
  const run = async (name, action, effect, script = steps(action)) => {
    const dir = join(root, name);
    await mkdir(join(dir, 'store'), { recursive: true });
    await mkdir(join(dir, 'work'));
    await new WorkflowStore(join(dir, 'work')).save('triage-crash', TRIAGE_WORKFLOW);
    const handle = { workspace: join(dir, 'work'), storePath: join(dir, 'store', 'run.sqlite'), definition: { instructions: 'Triage the issue.', skills: [] }, rules: '', seeded: { section: '' } };
    const r = await runOnce(handle, [issue.text], scriptedModel(script), [], issue.values, effect);
    return { handle, ...r };
  };

  const labels = async ({ input }) => ({ labels: input.labels });
  let twos = 0;
  const runTwo = (effect) => run(`two-${++twos}`, 'run', effect, [
    { call: 'agentrun', args: { action: 'load', name: 'triage-crash', input: ISSUES.third.input } },
    { call: 'agentrun', args: { action: 'run' } },
    { call: 'agentrun', args: { action: 'run', input: ISSUES.fourth.input } },
    { say: 'bug, needs-repro: triage-crash labeled both.' },
  ]);

  const down = await run('down', 'run', async () => { throw new Error('the tracker is down'); });
  const digest = JSON.parse(down.results[0]).saved.digest;
  assert.equal(JSON.parse(down.results[1]).outcome.status, 'refused');
  const [task] = toolTasks(down.handle);
  assert.equal(task.state.outcome.status, 'failed');
  const failed = await readUses({ store: down.handle.storePath, workDir: down.handle.workspace, run: 'run-1' });
  assert.deepEqual(failed.skipped, []);
  assert.deepEqual(failed.doc.uses.map((u) => [u.name, u.sha256, u.outcome]), [['triage-crash', digest, 'failed']]);

  // Two cases in one run are two tasks under two keys, so two records in the run's uses file. Curation takes a run as one use
  // of a revision, the worst outcome winning: one frozen and one failed case make a failed use, never two uses.
  const writer = admitRevision(undefined, { name: 'triage-crash', sha256: digest, run: 'writer', at: '2026-01-01T00:00:00.000Z', when: [] }).trial;
  const settle = (uses) => usesSettler()({
    main: 'main', run: 'run-1', uses, list: async () => [],
    read: async (path) => (path === trialPath('triage-crash') ? renderTrial(writer) : undefined),
  });
  const usesOf = async (r) => (await readUses({ store: r.handle.storePath, workDir: r.handle.workspace, run: 'run-1' })).doc.uses;

  const two = await runTwo(labels);
  assert.deepEqual(two.results.slice(1, 3).map((r) => JSON.parse(r).outcome.status), ['complete', 'complete']);
  assert.equal(toolTasks(two.handle).length, 2);
  const both = await usesOf(two);
  assert.deepEqual(both.map((u) => [u.name, u.sha256, u.outcome]), [['triage-crash', digest, 'frozen'], ['triage-crash', digest, 'frozen']], 'the store holds a record for each case');
  const counted = await settle(both);
  assert.deepEqual(parseTrial(counted.files[trialPath('triage-crash')], 'triage-crash').uses.map((u) => [u.run, u.outcome]), [['run-1', 'frozen']], 'one run with two cases is one use');
  assert.deepEqual(counted.decisions.map((d) => d.action), ['hold']);
  assert.match(counted.decisions[0].reason, /has 1 use in its trial; .*left out \(same_run\)$/);

  const mixed = await runTwo(async (params) => {
    if (params.input.title === ISSUES.fourth.input.title) throw new Error('the tracker is down');
    return labels(params);
  });
  assert.deepEqual(mixed.results.slice(1, 3).map((r) => JSON.parse(r).outcome.status), ['complete', 'refused']);
  assert.deepEqual((await usesOf(mixed)).map((u) => u.outcome).sort(), ['failed', 'frozen']);
  assert.deepEqual(parseTrial((await settle(await usesOf(mixed))).files[trialPath('triage-crash')], 'triage-crash').uses.map((u) => [u.run, u.outcome]), [['run-1', 'failed']], 'the worse case is the run\'s use');

  const dry = await run('dry', 'dry-run', async () => { throw new Error('a dry run calls no tool'); });
  assert.equal(JSON.parse(dry.results[1]).dryRun.status, 'passed');
  assert.deepEqual(toolTasks(dry.handle), [], 'a dry run starts no task');
  assert.equal((await readUses({ store: dry.handle.storePath, workDir: dry.handle.workspace, run: 'run-1' })).doc, undefined);
});

test('run 2\'s propose line and step 5 say what happened when run 2 saves a workflow without saying when to use it, only marks a use, or does nothing', async (t) => {
  const inspect = { call: 'agentrun', args: { action: 'inspect', workflow: TRIAGE_WORKFLOW, input: ISSUES.second.input } };
  const save = { call: 'agentrun', args: { action: 'save', name: 'triage-crash' } };
  const step5 = async (run2) => {
    const lines = [];
    const out = await runDemo({ dir: join(await scratch(t), 'demo'), log: (line) => lines.push(line), run2, promotion: false });
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
    dir: join(await scratch(t), 'demo'), log: (line) => lines.push(line), promotion: false,
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
  assert.match(stdout, /^9\. A workflow earns its place: later runs are offered triage-crash and run it with the agentrun tool$/m);
  assert.match(stdout, /^ {5}curate: run-7: triage-crash promote: its last 3 uses all finished frozen$/m);
  assert.match(stdout, /^ {5}curate: run-10: triage-crash demote, back to [0-9a-f]{12}: its last 2 uses ended escalated, escalated$/m);
  assert.match(stdout, /^git log --oneline main\n {2}[0-9a-f]{7} curate: run run-10: .* 1 settled\n(?: {2}[0-9a-f]{7} .*\n)*? {2}[0-9a-f]{7} retire L-[0-9a-f]{12}: the maintainer withdrew the rule\n/m);
  assert.deepEqual(await readdir(tmp), [], 'the temporary directory is removed');
});
