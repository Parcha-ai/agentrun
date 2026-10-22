// The MCC scorer: structural only, against the teacher (the grep swarm's answer), never against truth. Teacher agreement
// is one of the cell's two numbers; adjudicated accuracy (ADJUDICATION.md) is the other, and the two are never pooled.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RISK_TIERS = Object.freeze(['low', 'medium', 'high']);

/** The group table (build-mcc-groups.mjs): ISO 18245 ranges, Visa's T&E overrides and generic codes, the known codes. */
export const loadGroups = (path = join(import.meta.dirname, 'data', 'mcc-groups.json')) => JSON.parse(readFileSync(path, 'utf8'));

/** An MCC as four digits: a string of one to four digits, or a whole number below 10000, zero-padded; anything else
 *  is no code. */
export function mccOf(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value < 10_000 ? String(value).padStart(4, '0') : null;
  if (typeof value !== 'string') return null;
  const digits = value.trim();
  return /^\d{1,4}$/.test(digits) ? digits.padStart(4, '0') : null;
}

/** A code's group id: Visa's T&E block when Visa lists it under one outside that block's range, else its ISO range. */
export function groupOf(code, table) {
  if (code === null) return null;
  return table.overrides[code] ?? table.groups.find((g) => code >= g.from && code <= g.to)?.id ?? null;
}

/** The T&E block whose generic code this is (4511 airlines, 7512 car rental, 7011 lodging), else null. */
const teBlockOfGeneric = (code, table) => Object.entries(table.teGeneric).find(([, generic]) => generic === code)?.[0] ?? null;

/**
 * Same group: the same ISO range, or a T&E merchant-specific code against its block's generic code (Visa: an airline,
 * car rental or lodging merchant without its own code takes the generic one, so 3000 and 4511 are both "an airline").
 */
export function sameGroup(a, b, table) {
  if (a === null || b === null) return false;
  const ga = groupOf(a, table);
  const gb = groupOf(b, table);
  return (ga !== null && ga === gb) || (teBlockOfGeneric(a, table) !== null && teBlockOfGeneric(a, table) === gb) || (teBlockOfGeneric(b, table) !== null && teBlockOfGeneric(b, table) === ga);
}

/** A risk tier as low/medium/high (any case, outer space ignored), else null. */
export const riskOf = (value) => (typeof value === 'string' && RISK_TIERS.includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null);

/**
 * The score of one answer against the teacher's. Per field: the answer, the teacher's, right or wrong; null where the
 * teacher has no value (that field is not scored). `riskDistance` is the ordinal distance, 0 to 2; null when either side
 * has no tier. `mccKnown`: the answer is a code Visa lists, or one Citi lists for Mastercard (reported, never scored).
 * `correct` is every scored field right; `correctOver` names them.
 */
export function scoreMcc({ answer, teacher, table }) {
  const mccAnswer = mccOf(answer?.mcc);
  const mccTeacher = mccOf(teacher?.mcc);
  const riskAnswer = riskOf(answer?.risk);
  const riskTeacher = riskOf(teacher?.risk);
  const mccCorrect = mccTeacher === null ? null : mccAnswer === mccTeacher;
  const mccGroupCorrect = mccTeacher === null ? null : sameGroup(mccAnswer, mccTeacher, table);
  const riskCorrect = riskTeacher === null ? null : riskAnswer === riskTeacher;
  const riskDistance = riskAnswer === null || riskTeacher === null ? null : Math.abs(RISK_TIERS.indexOf(riskAnswer) - RISK_TIERS.indexOf(riskTeacher));
  const scored = [['mcc', mccCorrect], ['risk', riskCorrect]].filter(([, v]) => v !== null);
  return {
    against: 'teacher',
    mccAnswer, mccTeacher, mccCorrect,
    mccKnown: mccAnswer === null ? false : Boolean(table.codes[mccAnswer] ?? table.mastercardOnly[mccAnswer]),
    mccGroupAnswer: groupOf(mccAnswer, table), mccGroupTeacher: groupOf(mccTeacher, table), mccGroupCorrect,
    riskAnswer, riskTeacher, riskCorrect, riskDistance,
    correct: scored.length > 0 && scored.every(([, v]) => v === true),
    correctOver: scored.map(([name]) => name),
  };
}

const FIELDS = ['mccCorrect', 'mccGroupCorrect', 'riskCorrect', 'correct'];

function tally(rows) {
  const out = { n: rows.length };
  for (const field of FIELDS) {
    const scored = rows.filter((r) => r[field] !== null && r[field] !== undefined);
    const k = scored.filter((r) => r[field] === true).length;
    out[field] = { k, n: scored.length, rate: scored.length ? k / scored.length : null };
  }
  const distances = rows.map((r) => r.riskDistance).filter((d) => typeof d === 'number');
  out.riskDistanceMean = distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : null;
  out.riskOffByTwo = distances.filter((d) => d === 2).length;
  const costs = rows.map((r) => r.costUsd).filter((c) => typeof c === 'number');
  out.costPerJobUsd = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
  out.costUnknown = rows.length - costs.length;
  return out;
}

/**
 * Teacher agreement over scored rows (each a scoreMcc result with the merchant's `vertical`, and `costUsd` when the run
 * knows it): per field the count right, the scored count and the rate, overall and per vertical. Intervals come from
 * lanes/C1/ci.py (`wilson K N`, and `paired` for arm against arm), not from here.
 * `teacherGroupShare` is the share of teacher codes in each ISO group: a group holding most of them (5700-7299 spans
 * restaurants, pharmacies, direct marketing, crypto and dating) makes group agreement a weak signal, so it is shown.
 */
export function summarizeMcc(rows) {
  const byVertical = {};
  for (const row of rows) (byVertical[row.vertical ?? 'unknown'] ??= []).push(row);
  const groups = {};
  for (const row of rows) if (row.mccGroupTeacher) groups[row.mccGroupTeacher] = (groups[row.mccGroupTeacher] ?? 0) + 1;
  const withGroup = Object.values(groups).reduce((a, b) => a + b, 0);
  return {
    against: 'teacher',
    overall: tally(rows),
    byVertical: Object.fromEntries(Object.entries(byVertical).sort(([a], [b]) => a.localeCompare(b)).map(([v, list]) => [v, tally(list)])),
    teacherGroupShare: Object.fromEntries(Object.entries(groups).sort(([, a], [, b]) => b - a).map(([g, k]) => [g, k / withGroup])),
  };
}
