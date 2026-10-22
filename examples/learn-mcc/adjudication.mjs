// The adjudication sample and its blind packets (ADJUDICATION.md): a DEV sample stratified by vertical and committed by
// salted sha256 before anyone judges it; per merchant, the adjudicator's own code and the tiers the risk rubric allows,
// both recorded from the site before any answer is shown; then the two codes as A and B in an order only the salt
// recovers; and the verdicts turned back into one row per side for lanes/C1/ci.py.
import { createHash } from 'node:crypto';
import { RISK_TIERS } from './answer.mjs';
import { genericOf, mccOf, riskOf } from './score-mcc.mjs';

export const VERDICTS = Object.freeze(['A', 'B', 'both', 'neither']);

const sha256 = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex');

/** The commitment published for one sampled merchant: it names the merchant only to someone holding the salt. */
export const commitmentOf = (salt, merchantId) => sha256(salt, 'adjudication', merchantId);

/**
 * n merchants of `dev`, each stratum in proportion to its share of DEV (largest remainder; a stratum DEV has never goes
 * empty when n allows), the merchants inside a stratum picked in an order the salt fixes. A merchant's stratum is the
 * split's `stratum` (its vertical, or "seed" for a seed merchant, which has none), else its vertical. Returns the sample
 * in that order and the sorted commitments to publish.
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
    const key = m.stratum ?? m.vertical ?? 'unknown';
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

const codeShown = (value, groups) => {
  const mcc = mccOf(value);
  return { mcc, mccTitle: mcc === null ? null : groups.codes[mcc] ?? 'not in the code table' };
};

/**
 * The blind packet for one merchant, in two stages. `site`: its name and website, all the adjudicator has while it
 * records its own code and the tiers the rubric allows. `codes`: the learner's and the teacher's (`merchant.teacher`)
 * codes as A and B, each under its title from the code table. No tier, rationale, evidence, confidence or flag is shown:
 * each carries its source's style, and the teacher may have no tier at all, which would name its side.
 */
export function packetOf({ merchant, answer, salt, groups }) {
  const l = codeShown(answer?.mcc, groups);
  const t = codeShown(merchant.teacher?.mcc, groups);
  const [A, B] = learnerSide(salt, merchant.merchantId) === 'A' ? [l, t] : [t, l];
  return { site: { merchantId: merchant.merchantId, name: merchant.name, website: merchant.website }, codes: { merchantId: merchant.merchantId, A, B, same: A.mcc === B.mcc } };
}

const hasEvidence = (given) => Array.isArray(given?.evidence) && given.evidence.length > 0 && given.evidence.every((e) => e?.url && e?.quote);

/** The tiers a risk verdict allows: one tier, or two next to each other when the evidence supports both readings. */
function allowedTiers(risk, id) {
  const tiers = Array.isArray(risk?.tiers) ? risk.tiers.map(riskOf) : [];
  const at = tiers.map((t) => RISK_TIERS.indexOf(t)).sort();
  if (!tiers.length || tiers.length > 2 || tiers.includes(null) || (at.length === 2 && at[1] - at[0] !== 1)) throw new Error(`${id}: the risk verdict allows one tier, or two next to each other`);
  if (!hasEvidence(risk)) throw new Error(`${id}: the risk verdict needs evidence, a url and a quote each`);
  return at;
}

/**
 * The verdicts back to one row per side. A verdict is `{ own: { mcc, evidence }, risk: { tiers, evidence }, mcc: {
 * verdict, evidence } }`: the adjudicator's own code and the allowed tiers from the site alone, then A, B, both or neither
 * for the two codes (where they are the same, only both or neither). A side is right on the code when the verdict names
 * it or says both, and on the tier when its tier is an allowed one; `riskAdjDistance` is the distance to the nearest
 * allowed tier. A side without a tier (the teacher before its risk stage) has the tier fields null. `items` pairs each
 * merchant with the learner's answer. A merchant judged `{ unjudgeable: reason }` is left out of both sides and listed.
 */
export function unblind({ items, verdicts, salt }) {
  const learner = [];
  const teacher = [];
  const unjudgeable = [];
  for (const { merchant, answer } of items) {
    const id = merchant.merchantId;
    const v = verdicts[id];
    if (!v) throw new Error(`no verdict for ${id}`);
    if (typeof v.unjudgeable === 'string' && v.unjudgeable) {
      unjudgeable.push({ merchantId: id, reason: v.unjudgeable });
      continue;
    }
    const own = mccOf(v.own?.mcc);
    if (own === null || !hasEvidence(v.own)) throw new Error(`${id}: the verdict needs the adjudicator's own code with evidence`);
    const allowed = allowedTiers(v.risk, id);
    if (!VERDICTS.includes(v.mcc?.verdict)) throw new Error(`${id}: the mcc verdict must be one of ${VERDICTS.join(', ')}`);
    if (!hasEvidence(v.mcc)) throw new Error(`${id}: the mcc verdict needs evidence, a url and a quote each`);
    const sides = { learner: answer ?? {}, teacher: merchant.teacher ?? {} };
    if (mccOf(sides.learner.mcc) === mccOf(sides.teacher.mcc) && (v.mcc.verdict === 'A' || v.mcc.verdict === 'B')) throw new Error(`${id}: both sides gave the same code, so only both or neither can hold`);
    const learnerOn = learnerSide(salt, id);
    for (const [who, out] of [['learner', learner], ['teacher', teacher]]) {
      const on = who === 'learner' ? learnerOn : learnerOn === 'A' ? 'B' : 'A';
      const tier = riskOf(sides[who].riskTier);
      const mccAdjRight = v.mcc.verdict === 'both' || v.mcc.verdict === on;
      const riskAdjRight = tier === null ? null : allowed.includes(RISK_TIERS.indexOf(tier));
      out.push({
        merchantId: id, vertical: merchant.stratum ?? merchant.vertical ?? null, side: who,
        mccAdjRight, mccOwnExact: genericOf(mccOf(sides[who].mcc)) === genericOf(own),
        riskAdjRight, riskAdjDistance: tier === null ? null : Math.min(...allowed.map((a) => Math.abs(a - RISK_TIERS.indexOf(tier)))),
        adjRight: riskAdjRight === null ? null : mccAdjRight && riskAdjRight,
      });
    }
  }
  return { learner, teacher, unjudgeable };
}

/** A markdown section by its heading line, up to the next heading of the same or a higher level: the rubric text the
 *  adjudicator is given word for word, and its sha256 to pin before the first verdict. */
export function sectionOf(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) throw new Error(`no section ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l) && l.match(/^#+/)[0].length <= level);
  const text = lines.slice(start, end < 0 ? lines.length : end).join('\n').trimEnd();
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
}
