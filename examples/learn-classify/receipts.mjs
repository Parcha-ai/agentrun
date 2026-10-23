// ARM C, "learn-receipt" (01-loop.md 1.17): admission and promotion by receipt. A run's receipt (eval-lookup.mjs
// receiptOf) is the run having read the SEC's own record of the code it answered, and cited it.
// - --admit-by-receipt: a lesson or fact of a run with a receipt, LINKED to it (its evidence names the receipt's page, or
//   Jev says it tells the agent to read the code from a page of that kind), is proposed as the run's own work, so curate
//   does not ask fromContent; every other question, the guard (which refuses the code too) and sticky scores still apply.
// - --receipt-holds-trial: a workflow revision with no workflow receipt does not replace a live trial that has one.
// - --receipt-uses: a use whose run holds a receipt by that revision's own nodes is a correct SIC use; a use whose
//   revision read a record page showing one code and answered another (a receipt contradiction) is a failed use. A first
//   promotion follows the package's clean uses, or one receipt use, with no gate. A revision that replaces a serving one
//   serves at once, and the bank gate compares it with the one it replaced: the verdict confirms or demotes it.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyDecision, currentRevision, parseTrial, renderTrial, trialPath } from '@parcha/pi-agent-learn';
import { workflowSha256 } from '@parcha/agentrun-dsl';
import { lastProven, recordedWorkflow } from './dispatch.mjs';

/** The Jev question that links a note to a run's receipt when its evidence does not name the page. */
export const LINK_QUESTION = 'Does `learning` tell the agent to read the `field` value from a page of the kind `kind`?';

/** How each lesson and fact of a run is linked to its receipt: `url` when one of its evidence items holds the receipt's
 *  page address exactly, else `jev` when `ask` (Jev, LINK_QUESTION) answers at 0.8 or more, else none. Returns one entry
 *  per note, `{ candidate (its place in the inbox, from 1), callId, type, link, p }`. `field` is the answer's field the
 *  receipt grounds (the SEC job's sic4, the MCC job's mcc). */
export async function receiptLinks(candidates, receipt, ask, { field = 'sic4' } = {}) {
  const out = [];
  for (const [i, c] of candidates.entries()) {
    if (c.type !== 'lesson' && c.type !== 'fact') continue;
    const byUrl = (c.evidence ?? []).some((item) => typeof item === 'string' && item.includes(receipt.url));
    const p = byUrl ? null : await ask({ learning: { type: c.type, text: c.text }, field, kind: receipt.kind });
    out.push({ candidate: i + 1, callId: c.callId, type: c.type, link: byUrl ? 'url' : p >= 0.8 ? 'jev' : null, p });
  }
  return out;
}

/** What the host keeps per run, in <dir>/<run>.json: its receipt, its receipt contradiction, the revisions it ran, and
 *  whether a workflow's node read an archived SEC page. */
export function recordRun(dir, record) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${record.run}.json`);
  writeFileSync(`${file}.pending`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${file}.pending`, file);
}

const runsIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : []);
const runOf = (dir, run) => (existsSync(join(dir, `${run}.json`)) ? JSON.parse(readFileSync(join(dir, `${run}.json`), 'utf8')) : undefined);

/** True when a run recorded under `dir` ran `sha256` and holds a receipt read by a workflow's node. */
export const hasWorkflowReceipt = (dir, sha256) => runsIn(dir).some((r) => r.receipt?.byWorkflow === true && (r.executed ?? []).includes(sha256));

/** The digest a proposed workflow's records end on (`latest`), or null. */
const digestOf = (records) => (typeof records?.latest === 'string' ? records.latest.trim() : null);

/** The newcomer's workflow from the run's own records, when its record hashes to its digest. */
function recordsWorkflow(records, digest) {
  try {
    const record = JSON.parse(records?.[`${digest}.json`] ?? 'null');
    return record?.digest === digest && workflowSha256(record.workflow) === digest ? record.workflow : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `admitWorkflow` port with --receipt-holds-trial: a newcomer that has no workflow receipt is held while its name's
 * live revision, a trial or the champion, has one; anything else goes to `admit` as before. With `challenge` ({ gate,
 * capUsd }, --challenge-on-hold), a newcomer so held against a receipted CHAMPION is still held, but, when `admit` would
 * admit it, the promotion gate is asked to compare it with that champion on the bank (`challenger`): a landed verdict
 * that passes (LB > 0) makes it the champion at a later curate (asyncGate.apply). Once the comparisons have spent
 * `capUsd`, a hold is a plain hold again, its reason says so, and the gate counts it (challengeTally).
 */
export function receiptHoldsTrial(admit, dir, challenge) {
  return async (input) => {
    const { name, records } = input.workflow;
    let live;
    try {
      const text = await input.read(trialPath(name), input.main);
      live = text === undefined ? undefined : currentRevision(parseTrial(text, name));
    } catch {
      // A trial that does not parse is the admitter's to judge.
      return admit(input);
    }
    const incoming = digestOf(records);
    if (!(live && incoming && incoming !== live.sha256 && hasWorkflowReceipt(dir, live.sha256) && !hasWorkflowReceipt(dir, incoming))) return admit(input);
    const held = { status: 'held', reason: `the live ${live.status === 'active' ? 'champion' : 'trial'} ${live.sha256.slice(0, 12)} has a workflow receipt and this revision has none, so it does not replace it` };
    if (!challenge || live.status !== 'active') return held;
    if (challenge.gate.challengeSpend() >= challenge.capUsd) {
      challenge.gate.challengeUncompared({ name, candidate: incoming, serving: live.sha256 });
      return { ...held, reason: `${held.reason}; the challenge budget of $${challenge.capUsd} is spent, so it is not compared` };
    }
    const workflow = recordsWorkflow(records, incoming);
    const champion = await recordedWorkflow(input, name, live.sha256, input.main);
    if (!workflow || !champion) return held;
    // The newcomer must pass every admission check before the bank spends anything on it; what `admit` writes is not kept.
    const checked = await admit(input);
    if (checked?.status !== 'admitted') return checked;
    const asked = challenge.gate.ask({ name, candidate: { sha256: incoming, workflow }, serving: { sha256: live.sha256, workflow: champion }, main: input.main, challenger: input.workflow });
    return { ...held, reason: `${held.reason}; ${asked.status === 'landed' ? 'its challenge has landed already' : 'queued to challenge it on the bank'}` };
  };
}

/**
 * The `settleUses` port with --receipt-uses, over `settle` (pi-agent-learn's usesSettler).
 * - This run's uses of a revision it contradicted (receipts/<run>.json `contradiction`) are failed uses.
 * - A live trial with a receipt use in this run is promoted at once when the uses did not already promote it.
 * - A promotion of a trial with a revision before it (the last proven one) asks `gate` (asyncGate), when given, to
 *   compare the two (`confirm`): its verdict confirms or demotes the promotion at a later curate (`gate.apply`).
 * With `receipts` false, only the last: no contradiction and no receipt use counts. Demotions and holds pass as they are.
 */
export function receiptUses({ settle, dir, gate, receipts = true }) {
  return async (input) => {
    // Without receipts (--promote-no-floor alone) the uses are the package's, and only the comparison of a replacement is asked.
    const record = receipts ? runOf(dir, input.run) : undefined;
    const contradicted = record?.contradiction ? new Set(record.executed ?? []) : new Set();
    const uses = input.uses.map((u) => (contradicted.has(u.sha256) && u.outcome !== 'failed' ? { ...u, outcome: 'failed' } : u));
    const result = await settle({ ...input, uses });
    const files = { ...result.files };
    const decisions = [...result.decisions];
    const receiptRevisions = record?.receipt?.byWorkflow === true ? new Set(record.executed ?? []) : new Set();
    for (const name of [...new Set(uses.map((u) => u.name))]) {
      const path = trialPath(name);
      let before;
      let now;
      try {
        before = parseTrial(await input.read(path, input.main), name);
        now = typeof files[path] === 'string' ? parseTrial(files[path], name) : before;
      } catch {
        continue;
      }
      const live = currentRevision(now);
      const promotedByUses = decisions.some((d) => d.name === name && d.action === 'promote');
      if (!promotedByUses && live?.status === 'trial' && receiptRevisions.has(live.sha256) && !decisions.some((d) => d.name === name && d.action === 'demote')) {
        // One receipt use promotes: the uses fold first, then the promotion, at this run's last use of the revision.
        const last = uses.filter((u) => u.name === name && u.sha256 === live.sha256).map((u) => u.at).sort().at(-1) ?? new Date().toISOString();
        files[path] = renderTrial(applyDecision(now, { action: 'promote', sha256: live.sha256, reason: 'a use with a workflow receipt' }, last));
        const i = decisions.findIndex((d) => d.name === name);
        const promotion = { name, action: 'promote', reason: 'its use in this run read the SEC record of the code it answered (a workflow receipt)' };
        if (i >= 0) decisions[i] = promotion;
        else decisions.push(promotion);
      }
      const promoted = decisions.some((d) => d.name === name && d.action === 'promote');
      const candidate = currentRevision(before);
      const replaced = lastProven(before);
      if (gate && promoted && candidate && replaced) {
        const [workflow, served] = await Promise.all([recordedWorkflow(input, name, candidate.sha256, input.main), recordedWorkflow(input, name, replaced.sha256, input.main)]);
        const receipt = receiptRevisions.has(candidate.sha256);
        if (workflow && served) gate.ask({ name, candidate: { sha256: candidate.sha256, workflow }, serving: { sha256: replaced.sha256, workflow: served }, main: input.main, confirm: true, front: receipt, receipt });
      }
    }
    return { files, decisions };
  };
}
