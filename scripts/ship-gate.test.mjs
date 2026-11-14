import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bindingFor, planShip } from './ship-gate.mjs';

const hex = n => n.toString(16).padStart(40, '0');
function snapshot() {
  const facts = {
    repository: 'Parcha-ai/agentrun', trunk: { ref: 'main', sha: hex(1) },
    stack: { id: 91, members: [10, 11], source: 'api:stack/91' }, selected: [11],
    scope: { prs: [10, 11], source: 'session:ship-stack-91' },
    rules: { verified: true, source: 'api:rules/main', ref: 'main',
      requiredChecks: ['verify', 'lean'], requiredCheckApps: { verify: 15368, lean: 15368 },
      queueRequired: true, queueMethod: 'SQUASH', currentHeadGreen: true,
      staleApprovalsDismissed: true, approvalCount: 1, threadsRequired: true,
      nativeQueueAction: { supported: true, action: 'merge_queue', source: 'source:native-api' } },
    maintainers: [{ login: 'miguelrios', eligible: true, source: 'api:permission+codeowners' }],
    identities: [{ login: 'miguelrios', existing: true, canReview: true, source: 'api:owner/user' }],
    prs: [10, 11].map((number, index) => ({ number, state: 'OPEN', author: 'app/claudio-michel',
      parent: index ? 10 : null, head: hex(10 + index), headRef: `branch-${number}`,
      baseRef: index ? 'branch-10' : 'main', baseSha: hex(index ? 10 : 1),
      mergeBase: hex(index ? 10 : 1), parentIsAncestor: true, isDraft: false,
      mergeable: 'MERGEABLE', unresolvedThreads: 0,
      classification: { source: 'review:diff', hardBlocks: [], softBlocks: [] },
      ci: { source: 'api:checks', checks: ['verify', 'lean', 'stranger'].map(name => ({
        name, head: hex(10 + index), status: 'completed', conclusion: 'success',
        appId: 15368, source: `api:checks/${number}/${name}`,
      })) },
      reviews: [{ author: 'miguelrios', state: 'APPROVED', head: hex(10 + index),
        counts: true, source: 'api:reviews/7' }],
    })),
  };
  for (const pr of facts.prs) {
    pr.gate = { binding: bindingFor(facts, pr.number) };
    for (const gate of ['local', 'proof', 'description', 'review', 'threads', 'stackTrial', 'handoff'])
      pr.gate[gate] = { status: 'pass', source: `receipt:${pr.number}/${gate}` };
  }
  facts.consents = facts.prs.map(pr => ({ pr: pr.number, kind: 'task', actor: 'miguelrios',
    actorVerified: true, repository: facts.repository, actions: ['approve', 'queue'],
    source: 'session:owner-auto-approve-stack-91', binding: bindingFor(facts, pr.number) }));
  return facts;
}
const rejects = (facts, text, options = { phase: 'queue' }) => {
  const result = planShip(facts, options);
  assert.equal(result.ready, false, JSON.stringify(result));
  assert.ok(result.blockers.some(b => b.includes(text)), JSON.stringify(result));
  return result;
};

test('fully gated authorized closure yields separate preparation, approval and queue decisions', () => {
  const facts = snapshot();
  assert.equal(planShip(facts).action, 'handoff');
  assert.equal(planShip(facts, { phase: 'approve' }).action, 'approval-eligible');
  const queued = planShip(facts, { phase: 'queue' });
  assert.deepEqual(queued.closure, [10, 11]);
  assert.equal(queued.nativeQueueAction, 'merge_queue');
  assert.equal(queued.action, 'queue-eligible');
  assert.equal('merged' in queued, false);
});

test('selecting a child cannot authorize or bypass its ancestor', () => {
  let facts = snapshot(); facts.scope.prs = [11];
  assert.equal(rejects(facts, 'outside verified user scope').ownerProbeAllowed, false);
  facts = snapshot(); facts.prs[0].gate.proof.status = 'untested';
  assert.equal(rejects(facts, 'Gate incomplete: proof').ownerProbeAllowed, false);
  facts = snapshot(); facts.consents.shift();
  assert.equal(rejects(facts, 'Consent missing').ownerProbeAllowed, false);
});

test('native membership independently detects an omitted intermediate ancestor', () => {
  const facts = snapshot();
  facts.stack.members.splice(1, 0, 12);
  facts.prs.push({ ...structuredClone(facts.prs[0]), number: 12 });
  rejects(facts, 'membership or dependency order');
});

test('authorized ancestor prefix excludes the descendant', () => {
  const facts = snapshot(); facts.selected = [10]; facts.scope.prs = [10];
  facts.prs[1].gate.proof.status = 'blocked'; facts.consents.pop();
  const result = planShip(facts, { phase: 'queue' });
  assert.equal(result.ready, true);
  assert.deepEqual(result.closure, [10]);
});

for (const field of ['head', 'baseRef', 'baseSha', 'mergeBase']) {
  test(`changed ${field} invalidates evidence and consent`, () => {
    const facts = snapshot(); facts.prs[1][field] = field === 'baseRef' ? 'other-base' : hex(90);
    rejects(facts, 'Stale or absent gate binding');
  });
}

test('parent and trunk changes invalidate descendant bindings even when child head stays fixed', () => {
  let facts = snapshot(); facts.prs[0].head = hex(91);
  let result = rejects(facts, 'Stale or absent gate binding');
  assert.ok(result.blockers.some(b => b.startsWith('PR 11: Stale')));
  facts = snapshot(); facts.trunk.sha = hex(92);
  result = rejects(facts, 'Stale or absent gate binding');
  assert.ok(result.blockers.some(b => b.startsWith('PR 11: Stale')));
});

test('fresh gates alone cannot reuse a stale exact-revision consent', () => {
  const facts = snapshot(); facts.prs[1].mergeBase = hex(93);
  facts.prs[1].gate.binding = bindingFor(facts, 11);
  rejects(facts, 'Consent missing, stale');
});

test('worker, preparation-only and dry-run modes never consume approving identities', () => {
  for (const options of [{ phase: 'queue', role: 'worker' }, { phase: 'approve', prepareOnly: true },
    { phase: 'approve', dryRun: true }, { phase: 'queue', dryRun: true }, { phase: 'prepare' }]) {
    const facts = snapshot();
    Object.defineProperty(facts, 'identities', { get() { throw new Error('owner identity read'); } });
    const result = planShip(facts, options);
    assert.equal(result.ownerProbeAllowed, false);
    assert.ok(['blocked', 'inspect', 'handoff'].includes(result.action));
  }
});

test('owner probe allowed only after whole closure gates and consent, approval still needs verified account', () => {
  const facts = snapshot(); delete facts.identities;
  const result = rejects(facts, 'Approving identity unverified', { phase: 'approve' });
  assert.equal(result.ownerProbeAllowed, true);
});

test('unknown bot, non-owner identity, human self-approval and unverified maintainer are rejected', () => {
  let facts = snapshot(); facts.prs[1].author = 'app/new-bot';
  rejects(facts, 'No delegated bot-owner mapping');
  facts = snapshot(); facts.identities[0].login = 'claudio-michel[bot]';
  rejects(facts, 'Approving identity unverified');
  facts = snapshot(); facts.prs[1].author = 'miguelrios';
  rejects(facts, 'No delegated bot-owner mapping');
  facts = snapshot(); facts.maintainers[0].eligible = false;
  assert.equal(rejects(facts, 'not a verified eligible maintainer').ownerProbeAllowed, false);
});

test('neither standing nor generic task consent waives a hard block; informed task consent records it', () => {
  const facts = snapshot(); facts.prs[1].classification.hardBlocks = ['durability semantics'];
  rejects(facts, 'Hard blocks need informed');
  facts.consents[1].acknowledgedBlocks = ['durability semantics'];
  assert.equal(planShip(facts, { phase: 'approve' }).ready, true);
  facts.consents[1].kind = 'standing'; facts.consents[1].ownerConfigured = true;
  rejects(facts, 'Hard blocks need informed');
});

test('size/spread notes need an independent current-head review', () => {
  const facts = snapshot(); facts.prs[1].classification.softBlocks = ['size'];
  rejects(facts, 'Size/spread review missing');
  facts.prs[1].independentReview = { head: facts.prs[1].head, independent: true,
    verdict: 'SHIP', source: 'review:independent-current-head' };
  assert.equal(planShip(facts, { phase: 'queue' }).ready, true);
});

test('required checks cannot be absent, pending, stale, failed or supplied by the wrong App', () => {
  for (const mutate of [
    facts => { facts.prs[1].ci.checks.shift(); },
    facts => { facts.prs[1].ci.checks[0].status = 'in_progress'; },
    facts => { facts.prs[1].ci.checks[0].head = hex(99); },
    facts => { facts.prs[1].ci.checks[0].conclusion = 'failure'; },
    facts => { facts.prs[1].ci.checks[0].appId = 999; },
    facts => { facts.rules.requiredChecks = []; },
  ]) {
    const facts = snapshot(); mutate(facts);
    assert.equal(planShip(facts, { phase: 'queue' }).ready, false);
  }
});

test('a required path-filter skip needs a source, reason, exact head and merge-group coverage', () => {
  const facts = snapshot(); facts.prs[1].ci.checks[0].conclusion = 'skipped';
  rejects(facts, 'Check not passing: verify');
  facts.prs[1].ci.skips = [{ name: 'verify', head: facts.prs[1].head, source: 'workflow:on',
    reason: 'verified path filter', mergeGroup: true }];
  assert.equal(planShip(facts, { phase: 'queue' }).ready, true);
});

test('non-required red needs demonstrated base parity; it never excuses required red', () => {
  const facts = snapshot(); facts.prs[1].ci.checks[2].conclusion = 'failure';
  rejects(facts, 'Check not passing: stranger');
  Object.assign(facts.prs[1].ci.checks[2], { checkId: 301, runId: 401, attempt: 1,
    workflow: 'stranger.yml', event: 'pull_request', pr: 11, baseRef: 'branch-10' });
  facts.prs[1].ci.exceptions = [{ name: 'stranger', head: facts.prs[1].head,
    run: 'api:checks/11/stranger', check: { checkId: 301, runId: 401, attempt: 1,
      appId: 15368, workflow: 'stranger.yml', event: 'pull_request', pr: 11, baseRef: 'branch-10' },
    baseRun: 'run:main:5', cause: 'same recorded base failure' }];
  assert.equal(planShip(facts, { phase: 'queue' }).ready, true);
  facts.prs[1].ci.checks[0].conclusion = 'failure';
  facts.prs[1].ci.exceptions.push({ ...facts.prs[1].ci.exceptions[0], name: 'verify' });
  rejects(facts, 'Check not passing: verify');
});

test('a base-parity exception cannot cover another failed check, run, attempt or applicable context', () => {
  const facts = snapshot();
  Object.assign(facts.prs[1].ci.checks[2], { conclusion: 'failure', checkId: 301,
    runId: 401, attempt: 1, workflow: 'stranger.yml', event: 'pull_request', pr: 11, baseRef: 'branch-10' });
  facts.prs[1].ci.exceptions = [{ name: 'stranger', head: facts.prs[1].head,
    run: 'api:checks/11/stranger', check: { checkId: 301, runId: 401, attempt: 1,
      appId: 15368, workflow: 'stranger.yml', event: 'pull_request', pr: 11, baseRef: 'branch-10' },
    baseRun: 'run:main:399', cause: 'same recorded base failure' }];
  assert.equal(planShip(facts, { phase: 'queue' }).ready, true);
  for (const [field, value] of Object.entries({ checkId: 302, runId: 402, attempt: 2,
    appId: 999, workflow: 'other.yml', event: 'pull_request_target', pr: 12,
    baseRef: 'main', source: 'api:checks/11/stranger/run/402' })) {
    const changed = structuredClone(facts); changed.prs[1].ci.checks[2][field] = value;
    const result = planShip(changed, { phase: 'queue' });
    assert.equal(result.ready, false, `Exception must not cover changed ${field}`);
    assert.equal(result.ownerProbeAllowed, false);
  }
  const incomplete = structuredClone(facts);
  delete incomplete.prs[1].ci.checks[2].checkId;
  delete incomplete.prs[1].ci.exceptions[0].check.checkId;
  rejects(incomplete, 'Check not passing: stranger');
  delete facts.prs[1].ci.exceptions[0].check;
  rejects(facts, 'Check not passing: stranger');
});

test('a newer successful run supersedes cancelled attempts only within the same complete context', () => {
  const facts = snapshot(); const pr = facts.prs[1]; const success = pr.ci.checks[0];
  Object.assign(success, { workflow: 'ci.yml', event: 'pull_request', pr: 11,
    baseRef: pr.baseRef, runId: 120, attempt: 2 });
  const cancelled = { ...success, attempt: 1, conclusion: 'cancelled' };
  pr.ci.checks.push(cancelled);
  assert.equal(planShip(facts, { phase: 'queue' }).ready, true);
  cancelled.workflow = 'another.yml';
  rejects(facts, 'Check not passing: verify');
  cancelled.workflow = 'ci.yml'; cancelled.baseRef = 'main';
  rejects(facts, 'another PR/base context');
});

test('a newer applicable failure still blocks after an older green run', () => {
  const facts = snapshot(); const pr = facts.prs[1]; const old = pr.ci.checks[0];
  Object.assign(old, { workflow: 'ci.yml', event: 'pull_request', pr: 11,
    baseRef: pr.baseRef, runId: 120, attempt: 1 });
  pr.ci.checks.push({ ...old, attempt: 2, conclusion: 'failure' });
  rejects(facts, 'Check not passing: verify');
});

test('queue never proceeds without live protections and explicit supported queue-only action', () => {
  for (const field of ['queueRequired', 'currentHeadGreen', 'staleApprovalsDismissed', 'threadsRequired']) {
    const facts = snapshot(); facts.rules[field] = false;
    rejects(facts, 'Queue protection requirements');
  }
  for (const action of [undefined, { supported: false, action: 'merge_queue', source: 'api' },
    { supported: true, action: 'direct_merge', source: 'api' }]) {
    const facts = snapshot(); facts.rules.nativeQueueAction = action;
    rejects(facts, 'Explicit native queue-only action');
  }
});

test('approval receipt must count, match owner and current head; extra required approvals are respected', () => {
  for (const mutate of [
    facts => { facts.prs[0].reviews[0].head = hex(88); },
    facts => { facts.prs[0].reviews[0].counts = false; },
    facts => { facts.prs[0].reviews[0].author = 'claudio-michel[bot]'; },
    facts => { facts.rules.approvalCount = 2; },
  ]) {
    const facts = snapshot(); mutate(facts);
    rejects(facts, 'Current-head counted approvals missing');
  }
});

test('cycles, missing ancestors, closed members and unknown mergeability fail closed', () => {
  let facts = snapshot(); facts.prs[0].parent = 11; rejects(facts, 'Dependency cycle');
  facts = snapshot(); facts.prs.shift(); rejects(facts, 'Missing PR 10');
  facts = snapshot(); facts.prs[0].state = 'CLOSED'; rejects(facts, 'not open or merged');
  facts = snapshot(); facts.prs[1].mergeable = 'UNKNOWN'; rejects(facts, 'mergeability unverified');
});

test('merged ancestors are omitted only after descendants are re-gated onto trunk', () => {
  const facts = snapshot(); facts.prs[0].state = 'MERGED';
  rejects(facts, 'Live base or ancestry mismatch');
  const child = facts.prs[1]; child.baseRef = 'main'; child.baseSha = facts.trunk.sha;
  child.mergeBase = facts.trunk.sha; child.gate.binding = bindingFor(facts, 11);
  facts.consents[1].binding = bindingFor(facts, 11);
  const result = planShip(facts, { phase: 'queue' });
  assert.equal(result.ready, true); assert.deepEqual(result.closure, [11]);
  child.state = 'MERGED';
  assert.equal(planShip(facts, { phase: 'queue' }).action, 'complete');
});

test('CLI dry run reads only its snapshot and writes no evidence or auth files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentrun-ship-'));
  try {
    const file = join(directory, 'snapshot.json'); writeFileSync(file, JSON.stringify(snapshot()));
    const before = readFileSync(file, 'utf8');
    const child = spawnSync(process.execPath, [new URL('./ship-gate.mjs', import.meta.url).pathname,
      '--facts', file, '--phase', 'approve', '--dry-run'], {
      cwd: directory, encoding: 'utf8', env: { PATH: '', HOME: directory },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).action, 'inspect');
    assert.equal(JSON.parse(child.stdout).ownerProbeAllowed, false);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(readdirSync(directory), ['snapshot.json']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
