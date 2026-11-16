// Read-only checks over sourced snapshots. This module never authenticates or calls GitHub.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isMain } from './is-main.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const source = value => typeof value === 'string' && value.trim().length > 0;
const login = value => typeof value === 'string' ? value.replace(/^app\/(.+)$/, '$1[bot]').toLowerCase() : '';
const revision = pr => ({ number: pr.number, head: pr.head, baseRef: pr.baseRef,
  baseSha: pr.baseSha, mergeBase: pr.mergeBase });
const ownerByBot = new Map([
  ['claudio-michel[bot]', 'miguelrios'], ['chris-cache[bot]', 'chrisrodz'],
  ['sam-franchesko[bot]', 'sriverag'], ['bryan200-b200[bot]', 'bcollazo'],
  ['q-parcha-agent[bot]', 'ajasver'],
]);

function ancestors(facts, number, visiting = new Set()) {
  const pr = facts.prs.find(pr => pr.number === number);
  if (!pr) throw new Error(`Missing PR ${number}`);
  if (visiting.has(number)) throw new Error(`Dependency cycle at PR ${number}`);
  if (pr.state === 'MERGED') return [];
  if (pr.state !== 'OPEN') throw new Error(`PR ${number} is not open or merged`);
  visiting.add(number);
  const below = pr.parent == null ? [] : ancestors(facts, pr.parent, visiting);
  visiting.delete(number);
  return [...below, number];
}

/** Immutable evidence binding, including every unmerged dependency and trunk. */
export function bindingFor(facts, number) {
  const chain = ancestors(facts, number);
  const pr = facts.prs.find(pr => pr.number === number);
  return { repository: facts.repository, stackId: facts.stack?.id ?? null,
    trunk: { ...facts.trunk }, pr: revision(pr),
    dependencies: chain.filter(n => n !== number).map(n => revision(facts.prs.find(p => p.number === n))) };
}

function failedCheckIdentity(check) {
  const ids = ['checkId', 'runId', 'attempt', 'appId', 'pr'];
  const context = ['workflow', 'event', 'baseRef'];
  if (ids.some(key => !Number.isSafeInteger(check[key]) || check[key] < 1) ||
    context.some(key => !source(check[key]))) return null;
  return Object.fromEntries([...ids, ...context].map(key => [key, check[key]]));
}

function checkCI(facts, pr, block) {
  const checks = pr.ci?.checks;
  if (!Array.isArray(checks) || !source(pr.ci.source)) { block('CI data missing'); return; }
  const required = facts.rules?.requiredChecks;
  // Retain all results unless a newer attempt/run demonstrably supersedes the exact
  // same workflow/App/event/PR/base/check context. Commit-wide rollups lose this identity.
  const context = check => [check.name, check.appId, check.workflow, check.event, check.pr, check.baseRef];
  const ordered = check => Number.isSafeInteger(check.runId) && Number.isSafeInteger(check.attempt) &&
    source(check.workflow) && Number.isSafeInteger(check.appId) && check.event === 'pull_request' &&
    check.pr === pr.number && check.baseRef === pr.baseRef;
  const current = checks.filter(check => !ordered(check) || !checks.some(next => ordered(next) &&
    next.head === check.head && isDeepStrictEqual(context(next), context(check)) &&
    (next.runId > check.runId || (next.runId === check.runId && next.attempt > check.attempt))));
  const skip = (name, head) => pr.ci.skips?.some(s => s.name === name && s.head === head &&
    source(s.source) && source(s.reason) && s.mergeGroup === true);
  for (const name of required ?? []) {
    if (!current.some(c => c.name === name && c.head === pr.head &&
      (facts.rules.requiredCheckApps?.[name] == null || c.appId === facts.rules.requiredCheckApps[name])) && !skip(name, pr.head))
      block(`Required check missing: ${name}`);
  }
  for (const check of current) {
    if (check.head !== pr.head) { block(`Stale check: ${check.name}`); continue; }
    if ((check.pr != null && check.pr !== pr.number) || (check.baseRef != null && check.baseRef !== pr.baseRef)) {
      block(`Check has another PR/base context: ${check.name}`); continue;
    }
    if (!source(check.source)) block(`Check source missing: ${check.name}`);
    if (check.status !== 'completed') { block(`Check pending: ${check.name}`); continue; }
    if (check.conclusion === 'success') continue;
    if (check.conclusion === 'skipped' && skip(check.name, pr.head)) continue;
    const identity = failedCheckIdentity(check);
    const exception = identity && !required?.includes(check.name) && pr.ci.exceptions?.some(e =>
      e.name === check.name && e.head === pr.head && e.run === check.source &&
      isDeepStrictEqual(e.check, identity) && source(e.baseRun) && source(e.cause));
    if (!exception) block(`Check not passing: ${check.name}`);
  }
}

/** Returns decisions only. Input provenance must be verified by the calling coordinator. */
export function planShip(facts, { phase = 'prepare', dryRun = false, prepareOnly = false,
  role = 'coordinator' } = {}) {
  const blockers = [];
  const block = message => blockers.push(message);
  const result = { phase, action: 'blocked', ready: false, ownerProbeAllowed: false,
    closure: [], vector: [], blockers };
  if (!['prepare', 'approve', 'queue'].includes(phase)) block('Unsupported phase');
  if (!['coordinator', 'worker'].includes(role)) block('Unknown role');
  if (phase !== 'prepare' && (prepareOnly || role === 'worker')) block('Preparation scope forbids approval and queueing');
  if (!source(facts.repository) || facts.repository !== 'Parcha-ai/agentrun') block('Repository mismatch');
  if (!source(facts.trunk?.ref) || !sha(facts.trunk?.sha)) block('Trunk missing or invalid');
  if (!Array.isArray(facts.prs) || !Array.isArray(facts.selected) || !facts.selected.length) {
    block('PR data or selection missing'); return result;
  }
  if (!facts.trunk?.ref || !facts.trunk?.sha) return result;
  const numbers = facts.prs.map(p => p.number);
  if (numbers.some(n => !Number.isSafeInteger(n) || n < 1) || new Set(numbers).size !== numbers.length)
    block('PR numbers invalid or duplicated');
  try {
    result.closure = [...new Set(facts.selected.flatMap(n => ancestors(facts, n)))];
    result.vector = result.closure.map(n => bindingFor(facts, n));
  } catch (error) { block(error.message); return result; }
  if (facts.stack) {
    if (!source(facts.stack.source) || !Number.isSafeInteger(facts.stack.id) ||
      !Array.isArray(facts.stack.members) || new Set(facts.stack.members).size !== facts.stack.members?.length)
      block('Native membership unverified');
    else {
      const top = Math.max(...facts.selected.map(n => facts.stack.members.indexOf(n)));
      const nativeClosure = facts.stack.members.slice(0, top + 1).filter(n =>
        facts.prs.find(pr => pr.number === n)?.state !== 'MERGED');
      if (facts.selected.some(n => !facts.stack.members.includes(n)) ||
        !isDeepStrictEqual(result.closure, nativeClosure)) block('Native membership or dependency order mismatch');
    }
  } else if (result.closure.length > 1) block('Multiple PRs need native stack membership');
  if (result.closure.length === 0) {
    result.ready = blockers.length === 0;
    if (result.ready) result.action = 'complete';
    return result;
  }
  if (!facts.scope || !source(facts.scope.source) || !Array.isArray(facts.scope.prs) ||
    result.closure.some(n => !facts.scope.prs.includes(n))) block('Ancestor closure outside verified user scope');
  const rules = facts.rules;
  if (rules?.verified !== true || !source(rules.source) || rules.ref !== facts.trunk?.ref ||
    !Array.isArray(rules.requiredChecks) || !rules.requiredChecks.length ||
    rules.requiredChecks.some(n => !source(n))) block('Effective required-check rules unverified or empty');
  for (const number of result.closure) {
    const pr = facts.prs.find(p => p.number === number);
    const fail = message => block(`PR ${number}: ${message}`);
    if (![pr.head, pr.baseSha, pr.mergeBase].every(sha) || !source(pr.headRef)) fail('Invalid revision');
    if (pr.isDraft !== false || pr.mergeable !== 'MERGEABLE') fail('Draft or mergeability unverified');
    const parent = pr.parent == null ? null : facts.prs.find(p => p.number === pr.parent);
    const base = parent && parent.state !== 'MERGED' ? { ref: parent.headRef, sha: parent.head } : facts.trunk;
    if (pr.baseRef !== base.ref || pr.baseSha !== base.sha || pr.parentIsAncestor !== true)
      fail('Live base or ancestry mismatch');
    if (!isDeepStrictEqual(pr.gate?.binding, bindingFor(facts, number))) fail('Stale or absent gate binding');
    for (const gate of ['local', 'proof', 'description', 'review', 'threads', 'stackTrial', 'handoff']) {
      if (pr.gate?.[gate]?.status !== 'pass' || !source(pr.gate?.[gate]?.source)) fail(`Gate incomplete: ${gate}`);
    }
    if (pr.unresolvedThreads !== 0) fail('Threads unresolved or unverified');
    if (!source(pr.classification?.source) || !Array.isArray(pr.classification.hardBlocks) ||
      !Array.isArray(pr.classification.softBlocks)) fail('Diff classification unverified');
    if (pr.classification?.softBlocks?.length && !(pr.independentReview?.head === pr.head &&
      pr.independentReview.independent === true && source(pr.independentReview.source) &&
      ['SHIP', 'SHIP WITH FOLLOW-UPS'].includes(pr.independentReview.verdict))) fail('Size/spread review missing');
    checkCI(facts, pr, fail);
  }
  // Dry runs classify ordinary facts only and never request or consume owner identity.
  if (dryRun) { result.action = 'inspect'; result.ready = blockers.length === 0; return result; }
  if (phase === 'prepare') {
    result.ready = blockers.length === 0;
    if (result.ready) result.action = 'handoff';
    return result;
  }
  for (const number of result.closure) {
    const pr = facts.prs.find(p => p.number === number);
    const fail = message => block(`PR ${number}: ${message}`);
    const owner = ownerByBot.get(login(pr.author));
    const consent = facts.consents?.find(c => c.pr === number);
    if (!owner) fail('No delegated bot-owner mapping');
    if (!consent || !['task', 'standing'].includes(consent.kind) || !source(consent.source) ||
      consent.actorVerified !== true || login(consent.actor) !== owner ||
      consent.repository !== facts.repository || !['approve', 'queue'].every(a => consent.actions?.includes(a)) ||
      !isDeepStrictEqual(consent.binding, bindingFor(facts, number))) fail('Consent missing, stale or outside scope');
    const hardBlocks = pr.classification?.hardBlocks ?? [];
    if (hardBlocks.length && (consent?.kind !== 'task' || hardBlocks.some(b => !consent.acknowledgedBlocks?.includes(b))))
      fail('Hard blocks need informed maintainer consent');
    if (consent?.kind === 'standing' && consent.ownerConfigured !== true) fail('Existing standing consent unverified');
    if (!facts.maintainers?.some(m => login(m.login) === owner && m.eligible === true && source(m.source)))
      fail('Mapped owner is not a verified eligible maintainer');
  }
  // A failed gate, uncovered ancestor or missing consent prevents even an owner probe.
  result.ownerProbeAllowed = blockers.length === 0;
  if (!result.ownerProbeAllowed) return result;
  for (const number of result.closure) {
    const pr = facts.prs.find(p => p.number === number);
    const owner = ownerByBot.get(login(pr.author));
    if (!facts.identities?.some(i => login(i.login) === owner && login(i.login) !== login(pr.author) &&
      i.existing === true && i.canReview === true && source(i.source))) block(`PR ${number}: Approving identity unverified`);
  }
  if (phase === 'queue') {
    if (rules.queueRequired !== true || rules.queueMethod !== 'SQUASH' || rules.currentHeadGreen !== true ||
      rules.staleApprovalsDismissed !== true || rules.threadsRequired !== true ||
      !Number.isSafeInteger(rules.approvalCount) || rules.approvalCount < 1) block('Queue protection requirements unverified');
    if (facts.stack && (rules.nativeQueueAction?.supported !== true || !source(rules.nativeQueueAction.source) ||
      rules.nativeQueueAction.action !== 'merge_queue')) block('Explicit native queue-only action unsupported or unverified');
    for (const number of result.closure) {
      const pr = facts.prs.find(p => p.number === number);
      const owner = ownerByBot.get(login(pr.author));
      const reviews = pr.reviews?.filter(r => r.head === pr.head && r.state === 'APPROVED' &&
        r.counts === true && login(r.author) !== login(pr.author) && source(r.source));
      if (!reviews?.some(r => login(r.author) === owner) ||
        new Set(reviews?.map(r => login(r.author))).size < rules.approvalCount)
        block(`PR ${number}: Current-head counted approvals missing`);
    }
  }
  result.ready = blockers.length === 0;
  if (result.ready) result.action = phase === 'approve' ? 'approval-eligible' : 'queue-eligible';
  if (result.ready && phase === 'queue' && facts.stack) result.nativeQueueAction = 'merge_queue';
  return result;
}

if (isMain(import.meta)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    let file;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (['--facts', '--phase', '--role'].includes(arg)) {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        if (arg === '--facts') file = value;
        else options[arg.slice(2)] = value;
      } else if (arg === '--dry-run') options.dryRun = true;
      else if (arg === '--prepare-only') options.prepareOnly = true;
      else throw new Error(`Unknown argument ${arg}`);
    }
    if (!file) throw new Error('Usage: node scripts/ship-gate.mjs --facts <snapshot.json> --phase prepare|approve|queue');
    const result = planShip(JSON.parse(readFileSync(file, 'utf8')), options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
