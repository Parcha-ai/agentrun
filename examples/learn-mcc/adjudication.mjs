// The adjudication sample and its blind packets (ADJUDICATION.md): a DEV sample stratified by vertical and committed by
// salted sha256 before anyone judges it, each merchant's two answers shown as A and B in an order only the salt
// recovers, and the verdicts turned back into one row per side for lanes/C1/ci.py.
import { createHash } from 'node:crypto';
import { mccOf, riskOf } from './score-mcc.mjs';

export const VERDICTS = Object.freeze(['A', 'B', 'both', 'neither']);
export const FIELDS = Object.freeze(['mcc', 'risk']);

const sha256 = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex');

/** The commitment published for one sampled merchant: it names the merchant only to someone holding the salt. */
export const commitmentOf = (salt, merchantId) => sha256(salt, 'adjudication', merchantId);

/**
 * n merchants of `dev`, each vertical in proportion to its share of DEV (largest remainder; a vertical DEV has never
 * goes empty when n allows), the merchants inside a vertical picked in an order the salt fixes. Returns the sample in
 * that order and the sorted commitments to publish.
 */
export function drawSample({ dev, n = 120, salt }) {
  if (typeof salt !== 'string' || salt.length < 32) throw new Error('the sample needs a salt of at least 32 characters');
  if (n > dev.length) throw new Error(`a sample of ${n} from ${dev.length} DEV merchants`);
  const ids = new Set();
  for (const m of dev) {
    if (typeof m.merchantId !== 'string' || !m.merchantId || ids.has(m.merchantId)) throw new Error(`DEV merchant ids must be distinct strings (${m.merchantId})`);
    ids.add(m.merchantId);
  }
  const strata = new Map();
  for (const m of dev) {
    const key = m.vertical ?? 'unknown';
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(m);
  }
  const keys = [...strata.keys()].sort();
  const quota = new Map(keys.map((k) => [k, Math.floor((n * strata.get(k).length) / dev.length)]));
  const byRemainder = [...keys].sort((a, b) => (n * strata.get(b).length) % dev.length - (n * strata.get(a).length) % dev.length || a.localeCompare(b));
  for (let left = n - [...quota.values()].reduce((a, b) => a + b, 0), i = 0; left > 0; left -= 1, i += 1) quota.set(byRemainder[i], quota.get(byRemainder[i]) + 1);
  for (const k of keys) {
    if (quota.get(k) > 0 || n < keys.length) continue;
    const donor = [...keys].sort((a, b) => quota.get(b) - quota.get(a) || a.localeCompare(b))[0];
    quota.set(donor, quota.get(donor) - 1);
    quota.set(k, 1);
  }
  const rank = (m) => sha256(salt, 'sample', m.merchantId);
  const sample = keys.flatMap((k) => [...strata.get(k)].sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, quota.get(k)));
  return { sample, commitments: sample.map((m) => commitmentOf(salt, m.merchantId)).sort(), quota: Object.fromEntries(quota) };
}

/** Which side the learner is on for this merchant: the salt fixes it, so neither the packet nor its order tells. */
export const learnerSide = (salt, merchantId) => (Number.parseInt(sha256(salt, 'order', merchantId).slice(0, 2), 16) & 1 ? 'B' : 'A');

/** What the adjudicator sees of one answer: the code, its Visa title, the tier. Nothing an answer's style could give
 *  away (rationale, evidence, confidence, flags) is shown. */
const shown = (answer, table) => {
  const mcc = mccOf(answer?.mcc);
  return { mcc, mccTitle: mcc === null ? null : table.codes[mcc] ?? table.mastercardOnly[mcc] ?? 'not in the code table', risk: riskOf(answer?.risk) };
};

/** The blind packet for one merchant: its name and website, and the learner's and the teacher's answers as A and B. */
export function packetOf({ merchant, learner, teacher, salt, table }) {
  const l = shown(learner, table);
  const t = shown(teacher, table);
  const [A, B] = learnerSide(salt, merchant.merchantId) === 'A' ? [l, t] : [t, l];
  return { merchantId: merchant.merchantId, name: merchant.name, website: merchant.website, A, B, same: Object.fromEntries(FIELDS.map((f) => [f, A[f] === B[f]])) };
}

/**
 * One verdict per field per merchant, back to one row per side. A verdict is `{ mcc: { verdict, evidence: [{ url,
 * quote }] }, risk: {...} }` with verdict A, B, both or neither, and evidence for every verdict; where both sides gave the
 * same value only both or neither can hold. A side is right on a field when the verdict names it or says both. A
 * merchant judged `{ unjudgeable: reason }` (the site does not load, or sells nothing now) is left out of both sides
 * and listed.
 */
export function unblind({ packets, verdicts, salt, verticals = {} }) {
  const learner = [];
  const teacher = [];
  const unjudgeable = [];
  for (const packet of packets) {
    const v = verdicts[packet.merchantId];
    if (!v) throw new Error(`no verdict for ${packet.merchantId}`);
    if (typeof v.unjudgeable === 'string' && v.unjudgeable) {
      unjudgeable.push({ merchantId: packet.merchantId, reason: v.unjudgeable });
      continue;
    }
    const side = learnerSide(salt, packet.merchantId);
    const other = side === 'A' ? 'B' : 'A';
    const row = (who) => ({ merchantId: packet.merchantId, vertical: verticals[packet.merchantId] ?? null, side: who });
    const l = row('learner');
    const t = row('teacher');
    for (const field of FIELDS) {
      const given = v[field];
      if (!given || !VERDICTS.includes(given.verdict)) throw new Error(`${packet.merchantId}: the ${field} verdict must be one of ${VERDICTS.join(', ')}`);
      if (!Array.isArray(given.evidence) || !given.evidence.length || given.evidence.some((e) => !e?.url || !e?.quote)) throw new Error(`${packet.merchantId}: the ${field} verdict needs evidence, a url and a quote each`);
      if (packet.same[field] && (given.verdict === 'A' || given.verdict === 'B')) throw new Error(`${packet.merchantId}: both sides gave the same ${field}, so only both or neither can hold`);
      l[`${field}AdjRight`] = given.verdict === 'both' || given.verdict === side;
      t[`${field}AdjRight`] = given.verdict === 'both' || given.verdict === other;
    }
    l.adjRight = l.mccAdjRight && l.riskAdjRight;
    t.adjRight = t.mccAdjRight && t.riskAdjRight;
    learner.push(l);
    teacher.push(t);
  }
  return { learner, teacher, unjudgeable };
}
