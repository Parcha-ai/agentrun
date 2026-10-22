// Blind adjudication of a sealed DEV sample (ADJUDICATION.md). Per merchant, one harness run (adjudicator-tools.mjs):
// stage 1 records the adjudicator's own code and the tiers the risk rubric allows, from the site alone; stage 2 shows
// the candidate codes (the teacher's and every judged arm's, each once, in an order the salt fixes, with no source) and
// records each as acceptable or not. Here: the candidates, and the verdicts turned back into one row per side for
// lanes/C1/ci.py. The sample itself is the data lane's sealed draw; nothing here draws one.
//
//   node adjudication.mjs candidates SAMPLE.json ORDER_SALT OUT.json ARM=ROWS.jsonl [ARM=ROWS.jsonl ...]
//   node adjudication.mjs unblind SAMPLE.json ARM_ROWS.jsonl STAGE1.json STAGE2.json OUT_DIR
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RISK_TIERS } from './answer.mjs';
import { genericOf, loadGroups, mccOf, riskOf } from './score-mcc.mjs';

const sha256 = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex');

/**
 * One merchant's candidate codes: every distinct 4-digit code among `codes` (the teacher's and the arms'), each with its
 * title from the code table, in an order the salt fixes. Nothing says whose a code is, and a code two sides share
 * appears once, so no candidate can be told apart as the teacher's.
 */
export function candidatesOf({ merchantId, codes, salt, groups }) {
  const distinct = [...new Set(codes.map(mccOf).filter((c) => c !== null))];
  return distinct
    .sort((a, b) => sha256(salt, 'order', merchantId, a).localeCompare(sha256(salt, 'order', merchantId, b)))
    .map((code) => ({ code, title: groups.codes[code] ?? 'not in the code table' }));
}

/**
 * An arm's answers by merchant, from its scored rows (`merchantId`, `mccAnswer`, `riskAnswer`), for the sample's
 * merchants in the sample's own `order`. A sample merchant the arm has no row for is `missing`: it is never judged for
 * that arm, and is listed. Two rows for one merchant are refused.
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

/** Every sample merchant's candidates over the teacher and the named arms (`[{ name, rows }]`), and what each arm is
 *  missing. A merchant with no candidate at all still gets its stage 1. */
export function candidateTable({ sample, arms, salt, groups }) {
  const answered = arms.map(({ name, rows }) => ({ name, ...armAnswers({ sample, rows }) }));
  const candidates = {};
  for (const merchant of [...sample].sort((a, b) => a.order - b.order)) {
    const codes = [merchant.teacher?.mcc, ...answered.flatMap((a) => a.items.filter((i) => i.merchant.merchantId === merchant.merchantId).map((i) => i.answer.mcc))];
    candidates[merchant.merchantId] = candidatesOf({ merchantId: merchant.merchantId, codes, salt, groups });
  }
  return { candidates, missing: Object.fromEntries(answered.map((a) => [a.name, a.missing])) };
}

const hasEvidence = (given) => Array.isArray(given?.evidence) && given.evidence.length > 0 && given.evidence.every((e) => e?.url && e?.quote);

/** The tiers a stage-1 risk judgment allows: one tier, or two next to each other when the evidence supports both. */
export function allowedTiers(risk, id = 'the merchant') {
  const tiers = Array.isArray(risk?.tiers) ? risk.tiers.map(riskOf) : [];
  const at = tiers.map((t) => RISK_TIERS.indexOf(t)).sort();
  if (!tiers.length || tiers.length > 2 || tiers.includes(null) || new Set(at).size !== at.length || (at.length === 2 && at[1] - at[0] !== 1)) throw new Error(`${id}: the risk judgment allows one tier, or two next to each other`);
  if (!hasEvidence(risk)) throw new Error(`${id}: the risk judgment needs evidence, a url and a quote each`);
  return at;
}

/**
 * The verdicts back to one row per side, for one arm. `stage1[id]` is `{ own: { mcc, evidence }, risk: { tiers,
 * evidence } }` or `{ unjudgeable: reason }`; `stage2[id].codes[code]` is `{ acceptable, evidence }` for every candidate.
 * A side is right on the code when its code was judged acceptable (no code is wrong), and on the tier when its tier is an
 * allowed one; `riskAdjDistance` is the distance to the nearest allowed tier. A side without a tier (the teacher before
 * its risk stage) has the tier fields null. An unjudgeable merchant is left out of both sides and listed.
 */
export function unblind({ items, stage1, stage2 }) {
  const learner = [];
  const teacher = [];
  const unjudgeable = [];
  for (const { merchant, answer } of items) {
    const id = merchant.merchantId;
    const s1 = stage1[id];
    if (!s1) throw new Error(`no stage 1 for ${id}`);
    if (typeof s1.unjudgeable === 'string' && s1.unjudgeable) {
      unjudgeable.push({ merchantId: id, reason: s1.unjudgeable });
      continue;
    }
    const own = mccOf(s1.own?.mcc);
    if (own === null || !hasEvidence(s1.own)) throw new Error(`${id}: stage 1 needs the adjudicator's own code with evidence`);
    const allowed = allowedTiers(s1.risk, id);
    const judged = (code) => {
      if (code === null) return false;
      const v = stage2[id]?.codes?.[code];
      if (!v || typeof v.acceptable !== 'boolean' || !hasEvidence(v)) throw new Error(`${id}: ${code} was not judged in stage 2, with evidence`);
      return v.acceptable;
    };
    const sides = { learner: answer ?? {}, teacher: merchant.teacher ?? {} };
    for (const [who, out] of [['learner', learner], ['teacher', teacher]]) {
      const code = mccOf(sides[who].mcc);
      const tier = riskOf(sides[who].riskTier);
      const mccAdjRight = judged(code);
      const riskAdjRight = tier === null ? null : allowed.includes(RISK_TIERS.indexOf(tier));
      out.push({
        merchantId: id, vertical: merchant.stratum ?? merchant.vertical ?? null, side: who,
        mccAdjRight, mccOwnExact: code !== null && genericOf(code) === genericOf(own),
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

const tallyOf = (rows) => Object.fromEntries(['mccAdjRight', 'mccOwnExact', 'riskAdjRight', 'adjRight'].map((f) => {
  const scored = rows.filter((r) => typeof r[f] === 'boolean');
  return [f, { k: scored.filter((r) => r[f]).length, n: scored.length }];
}));

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, samplePath, ...rest] = process.argv.slice(2);
  const readRows = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
  if (command === 'candidates') {
    const [saltPath, outPath, ...armArgs] = rest;
    const salt = readFileSync(saltPath, 'utf8').trim();
    if (salt.length < 32) throw new Error('the order salt must be at least 32 characters');
    const arms = armArgs.map((a) => ({ name: a.slice(0, a.indexOf('=')), rows: readRows(a.slice(a.indexOf('=') + 1)) }));
    if (!arms.length || arms.some((a) => !a.name)) throw new Error('name each arm: ARM=ROWS.jsonl');
    const table = candidateTable({ sample, arms, salt, groups: loadGroups() });
    writeFileSync(outPath, `${JSON.stringify(table.candidates, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ merchants: Object.keys(table.candidates).length, missing: Object.fromEntries(Object.entries(table.missing).map(([k, v]) => [k, v.length])) })}\n`);
  } else if (command === 'unblind') {
    const [rowsPath, stage1Path, stage2Path, outDir] = rest;
    const { items, missing } = armAnswers({ sample, rows: readRows(rowsPath) });
    const { learner, teacher, unjudgeable } = unblind({ items, stage1: JSON.parse(readFileSync(stage1Path, 'utf8')), stage2: JSON.parse(readFileSync(stage2Path, 'utf8')) });
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(outDir, 'learner.jsonl'), jsonl(learner), { mode: 0o600 });
    writeFileSync(join(outDir, 'teacher.jsonl'), jsonl(teacher), { mode: 0o600 });
    const summary = { learner: tallyOf(learner), teacher: tallyOf(teacher), unjudgeable, missing };
    writeFileSync(join(outDir, 'unblinded.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    throw new Error('usage: node adjudication.mjs candidates|unblind SAMPLE.json ...');
  }
}
