// Blind adjudication of a sealed DEV sample (ADJUDICATION.md): per merchant, the adjudicator's own code and the tiers the
// risk rubric allows, both recorded from the site before any answer is shown; then the learner's and the teacher's codes
// as A and B in an order only the salt recovers; and the verdicts turned back into one row per side for lanes/C1/ci.py.
// The sample itself is the data lane's sealed draw; nothing here draws one.
//
//   node adjudication.mjs packets SAMPLE.json ARM_ROWS.jsonl SALT_FILE OUT_DIR
//   node adjudication.mjs unblind SAMPLE.json ARM_ROWS.jsonl SALT_FILE STAGE1.json STAGE2.json OUT_DIR
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RISK_TIERS } from './answer.mjs';
import { genericOf, loadGroups, mccOf, riskOf } from './score-mcc.mjs';

export const VERDICTS = Object.freeze(['A', 'B', 'both', 'neither']);

const sha256 = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex');

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

/**
 * An arm's answers by merchant, from its scored rows (`merchantId`, `mccAnswer`, `riskAnswer`), for the sample's
 * merchants in the sample's own `order`. A sample merchant the arm has no row for is `missing`: it gets no packet and no
 * row, and is listed. Two rows for one merchant are refused.
 */
export function armAnswers({ sample, rows }) {
  const byId = new Map();
  for (const row of rows) {
    if (byId.has(row.merchantId)) throw new Error(`the arm has two rows for ${row.merchantId}`);
    byId.set(row.merchantId, { mcc: row.mccAnswer ?? null, riskTier: row.riskAnswer ?? null });
  }
  const ordered = [...sample].sort((a, b) => a.order - b.order);
  return {
    items: ordered.filter((m) => byId.has(m.merchantId)).map((merchant) => ({ merchant, answer: byId.get(merchant.merchantId) })),
    missing: ordered.filter((m) => !byId.has(m.merchantId)).map((m) => m.merchantId),
  };
}

/** One merchant's verdict from its two stages: stage 1 (`own`, `risk`, or `unjudgeable`) is the arm-free one every pass
 *  shares; stage 2 is this arm's `mcc` verdict. */
export const verdictsOf = (stage1, stage2) => Object.fromEntries(Object.entries(stage1).map(([id, s1]) => [id, s1.unjudgeable ? s1 : { ...s1, mcc: stage2[id]?.mcc }]));

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

const tallyOf = (rows) => Object.fromEntries(['mccAdjRight', 'mccOwnExact', 'riskAdjRight', 'adjRight'].map((f) => {
  const scored = rows.filter((r) => typeof r[f] === 'boolean');
  return [f, { k: scored.filter((r) => r[f]).length, n: scored.length }];
}));

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, samplePath, rowsPath, saltPath, ...rest] = process.argv.slice(2);
  const readRows = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  if (!['packets', 'unblind'].includes(command) || !samplePath || !rowsPath || !saltPath) throw new Error('usage: node adjudication.mjs packets|unblind SAMPLE.json ARM_ROWS.jsonl SALT_FILE ...');
  const salt = readFileSync(saltPath, 'utf8').trim();
  if (salt.length < 32) throw new Error('the order salt must be at least 32 characters');
  const { items, missing } = armAnswers({ sample: JSON.parse(readFileSync(samplePath, 'utf8')), rows: readRows(rowsPath) });
  if (command === 'packets') {
    const [outDir] = rest;
    const groups = loadGroups();
    const packets = items.map(({ merchant, answer }) => packetOf({ merchant, answer, salt, groups }));
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(outDir, 'site.jsonl'), jsonl(packets.map((p) => p.site)), { mode: 0o600 });
    writeFileSync(join(outDir, 'codes.jsonl'), jsonl(packets.map((p) => p.codes)), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ packets: packets.length, missing })}\n`);
  } else {
    const [stage1Path, stage2Path, outDir] = rest;
    const verdicts = verdictsOf(JSON.parse(readFileSync(stage1Path, 'utf8')), JSON.parse(readFileSync(stage2Path, 'utf8')));
    const { learner, teacher, unjudgeable } = unblind({ items, verdicts, salt });
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(outDir, 'learner.jsonl'), jsonl(learner), { mode: 0o600 });
    writeFileSync(join(outDir, 'teacher.jsonl'), jsonl(teacher), { mode: 0o600 });
    const summary = { learner: tallyOf(learner), teacher: tallyOf(teacher), unjudgeable, missing };
    writeFileSync(join(outDir, 'unblinded.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  }
}
