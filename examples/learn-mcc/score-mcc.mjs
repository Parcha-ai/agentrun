// The MCC scorer: structural only, against the teacher (the swarm's answer that came with the merchant record), never
// against truth. Teacher agreement is one of the cell's two numbers; adjudicated accuracy (ADJUDICATION.md) is the other,
// and the two are never pooled.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RISK_TIERS } from './answer.mjs';

const DATA = join(import.meta.dirname, 'data');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The group table (mcc-groups.json: ISO 18245 ranges, Visa's T&E overrides and generic codes) with the code table
 *  (mcc-codes.json, code to title) as `codes`: the files the mcc_groups and mcc_codes tools serve. */
export const loadGroups = (dir = DATA) => ({ ...readJson(join(dir, 'mcc-groups.json')), codes: readJson(join(dir, 'mcc-codes.json')) });

let shipped;
const defaultGroups = () => (shipped ??= loadGroups());

/** An MCC as four digits: a string of one to four digits, or a whole number below 10000, zero-padded (a teacher's CSV
 *  may drop the leading zero); anything else is no code. */
export function mccOf(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value < 10_000 ? String(value).padStart(4, '0') : null;
  if (typeof value !== 'string') return null;
  const digits = value.trim();
  return /^\d{1,4}$/.test(digits) ? digits.padStart(4, '0') : null;
}

/** A code's group id: Visa's T&E block when Visa lists it under one outside that block's range, else its ISO range. */
export function groupOf(code, groups = defaultGroups()) {
  if (code === null) return null;
  return groups.overrides[code] ?? groups.groups.find((g) => code >= g.from && code <= g.to)?.id ?? null;
}

/** The T&E block whose generic code this is (4511 airlines, 7512 car rental, 7011 lodging), else null. */
const teBlockOfGeneric = (code, groups) => Object.entries(groups.teGeneric).find(([, generic]) => generic === code)?.[0] ?? null;

/**
 * Same group: the same ISO range, or a T&E merchant-specific code against its block's generic code (Visa: an airline,
 * car rental or lodging merchant without its own code takes the generic one, so 3000 and 4511 are both "an airline").
 */
export function sameGroup(a, b, groups = defaultGroups()) {
  if (a === null || b === null) return false;
  const ga = groupOf(a, groups);
  const gb = groupOf(b, groups);
  const blockA = teBlockOfGeneric(a, groups);
  const blockB = teBlockOfGeneric(b, groups);
  return (ga !== null && ga === gb) || (blockA !== null && blockA === gb) || (blockB !== null && blockB === ga);
}

/**
 * A T&E merchant-specific code (an airline, car rental or lodging brand's own) as its block's generic code, 4511, 7512
 * or 7011 (Visa, General Requirements e); any other code as it is. The run is not offered brand codes, so an exact
 * match is judged on the generic code, on both sides.
 */
export function genericOf(code, groups = defaultGroups()) {
  const generic = code === null ? undefined : groups.teGeneric[groupOf(code, groups)];
  return generic ?? code;
}

/** A risk tier as low/medium/high (any case, outer space ignored), else null. */
export const riskOf = (value) => (typeof value === 'string' && RISK_TIERS.includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null);

const flagSet = (flags) => (Array.isArray(flags) ? [...new Set(flags.filter((f) => typeof f === 'string'))].sort() : null);

/**
 * The stage-1 labels (proposal C) by merchant: each line is the adjudicator's stage-1 record with its `merchantId`,
 * `{ merchantId, own: { mcc }, risk: { tiers } }` or `{ merchantId, unjudgeable }`. A label is `{ mcc, allowedTiers }`
 * (the tiers in rubric order) or `{ unjudgeable }`. A code not in the code table, tiers that are not one or two adjacent
 * ones, or a merchant labelled twice is refused.
 */
export function labelsOf(lines, groups = defaultGroups()) {
  const labels = {};
  for (const line of lines) {
    const id = line?.merchantId;
    if (typeof id !== 'string' || !id) throw new Error('a label line needs its merchantId');
    if (Object.hasOwn(labels, id)) throw new Error(`${id} is labelled twice`);
    if (typeof line.unjudgeable === 'string' && line.unjudgeable) {
      labels[id] = { unjudgeable: line.unjudgeable };
      continue;
    }
    const mcc = mccOf(line.own?.mcc);
    if (mcc === null || groups.codes[mcc] === undefined) throw new Error(`${id}: the label's code is not a code in the table`);
    const tiers = Array.isArray(line.risk?.tiers) ? line.risk.tiers.map(riskOf) : [];
    const at = [...new Set(tiers.map((t) => RISK_TIERS.indexOf(t)))].sort();
    if (!tiers.length || tiers.length > 2 || tiers.includes(null) || at.length !== tiers.length || (at.length === 2 && at[1] - at[0] !== 1)) throw new Error(`${id}: the label's tiers must be one tier, or two next to each other`);
    labels[id] = { mcc, allowedTiers: at.map((i) => RISK_TIERS[i]) };
  }
  return labels;
}

/** labelsOf over a labels-stage1.jsonl file. */
export const loadStage1Labels = (path, groups = defaultGroups()) => labelsOf(readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)), groups);

/**
 * One answer against the teacher block of its merchant row (`merchant.teacher`: { mcc, riskTier, flags }). Per field the
 * answer, the teacher's, right or wrong; a field the teacher has no value for is null, never wrong, and leaves the n.
 * The exact code is compared after genericOf on both sides; `brandMapped` says a brand code was mapped on either side.
 * `riskDistance` is the ordinal distance, 0 to 2. `correct` is the exact code. Reported, never scored: `mccKnown` (the
 * answer is in the code table), the flags and their Jaccard overlap with the teacher's, siteStatus, confidence.
 *
 * With `labels` (labelsOf; proposal C) the truth is the merchant's stage-1 label, on both fields: `against` 'stage1',
 * `mccTeacher` the label's code, `riskTeacher` its allowed tiers (an array), `riskCorrect` the tier being one of them,
 * `riskDistance` the distance to the nearest, and `correct` the code AND the tier. A merchant with no label, or an
 * unjudgeable one, is scored against the swarm teacher on the code alone and says why in `labelFallback`. Either way
 * `mccSwarm` and `mccSwarmCorrect` report the swarm's code beside, deciding nothing. Without `labels` nothing changes.
 */
export function scoreMcc({ answer, merchant, groups = defaultGroups(), labels }) {
  // A call without the merchant row would score every field null and look like a row with no teacher label.
  if (merchant === null || typeof merchant !== 'object') throw new Error('scoreMcc takes { answer, merchant, groups }: the merchant row, its teacher block at merchant.teacher');
  const teacher = merchant.teacher ?? null;
  const mccAnswer = mccOf(answer?.mcc);
  const mccTeacher = mccOf(teacher?.mcc);
  const riskAnswer = riskOf(answer?.riskTier);
  const riskTeacher = riskOf(teacher?.riskTier);
  const mccCorrect = mccTeacher === null ? null : genericOf(mccAnswer, groups) === genericOf(mccTeacher, groups);
  const brandMapped = genericOf(mccAnswer, groups) !== mccAnswer || genericOf(mccTeacher, groups) !== mccTeacher;
  const flagsAnswer = flagSet(answer?.flags);
  const flagsTeacher = flagSet(teacher?.flags);
  const union = flagsAnswer && flagsTeacher ? new Set([...flagsAnswer, ...flagsTeacher]).size : 0;
  const base = {
    against: 'teacher',
    mccAnswer, mccTeacher, mccCorrect, brandMapped,
    mccKnown: mccAnswer !== null && groups.codes[mccAnswer] !== undefined,
    mccGroupAnswer: groupOf(mccAnswer, groups), mccGroupTeacher: groupOf(mccTeacher, groups),
    mccGroupCorrect: mccTeacher === null ? null : sameGroup(mccAnswer, mccTeacher, groups),
    riskAnswer, riskTeacher,
    riskCorrect: riskTeacher === null ? null : riskAnswer === riskTeacher,
    riskDistance: riskAnswer === null || riskTeacher === null ? null : Math.abs(RISK_TIERS.indexOf(riskAnswer) - RISK_TIERS.indexOf(riskTeacher)),
    flagsAnswer, flagsTeacher,
    flagsJaccard: flagsAnswer && flagsTeacher ? (union ? flagsAnswer.filter((f) => flagsTeacher.includes(f)).length / union : 1) : null,
    siteStatus: typeof answer?.siteStatus === 'string' ? answer.siteStatus : null,
    confidence: typeof answer?.confidence === 'number' ? answer.confidence : null,
    correct: mccCorrect,
  };
  if (labels === undefined) return base;
  // A truth row names the merchant `merchantId`; the runner's job names it `id` (and `cik`, the same domain).
  const key = merchant.merchantId ?? merchant.id ?? merchant.cik;
  const label = Object.hasOwn(labels, key) ? labels[key] : null;
  const swarm = { mccSwarm: mccTeacher, mccSwarmCorrect: mccCorrect };
  if (label === null || label.unjudgeable) return { ...base, riskTeacher: null, riskCorrect: null, riskDistance: null, ...swarm, labelFallback: label === null ? 'unlabelled' : 'unjudgeable' };
  const truth = label.mcc;
  const codeRight = genericOf(mccAnswer, groups) === genericOf(truth, groups);
  const tierRight = riskAnswer !== null && label.allowedTiers.includes(riskAnswer);
  return {
    ...base,
    against: 'stage1',
    mccTeacher: truth, mccCorrect: codeRight,
    brandMapped: genericOf(mccAnswer, groups) !== mccAnswer || genericOf(truth, groups) !== truth,
    mccGroupTeacher: groupOf(truth, groups), mccGroupCorrect: sameGroup(mccAnswer, truth, groups),
    riskTeacher: label.allowedTiers, riskCorrect: tierRight,
    riskDistance: riskAnswer === null ? null : Math.min(...label.allowedTiers.map((t) => Math.abs(RISK_TIERS.indexOf(t) - RISK_TIERS.indexOf(riskAnswer)))),
    correct: codeRight && tierRight,
    ...swarm, labelFallback: null,
  };
}

const FIELDS = ['mccCorrect', 'mccGroupCorrect', 'riskCorrect'];
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

function tally(rows, stage1) {
  const out = { n: rows.length };
  for (const field of FIELDS) {
    const scored = rows.filter((r) => typeof r[field] === 'boolean');
    const k = scored.filter((r) => r[field]).length;
    out[field] = { k, n: scored.length, rate: scored.length ? k / scored.length : null };
  }
  const distances = rows.map((r) => r.riskDistance).filter((d) => typeof d === 'number');
  out.riskDistanceMean = mean(distances);
  out.riskOffByTwo = distances.filter((d) => d === 2).length;
  out.brandMapped = rows.filter((r) => r.brandMapped === true).length;
  // The confidence is the chance the code is the one a network would assign; against the teacher this is agreement, not
  // calibration to truth.
  const confident = rows.filter((r) => typeof r.confidence === 'number' && typeof r.mccCorrect === 'boolean');
  out.brierVsTeacher = mean(confident.map((r) => (r.confidence - (r.mccCorrect ? 1 : 0)) ** 2));
  out.flagsJaccardMean = mean(rows.map((r) => r.flagsJaccard).filter((j) => typeof j === 'number'));
  const costs = rows.map((r) => r.costUsd).filter((c) => typeof c === 'number');
  out.costPerJobUsd = mean(costs);
  out.costUnknown = rows.length - costs.length;
  if (stage1) {
    const labelled = rows.filter((r) => r.against === 'stage1');
    const k = labelled.filter((r) => r.correct === true).length;
    out.bothCorrect = { k, n: labelled.length, rate: labelled.length ? k / labelled.length : null };
    out.labelFallback = rows.filter((r) => r.labelFallback).length;
  }
  return out;
}

/**
 * Teacher agreement over scored rows (each a scoreMcc result with the merchant's `stratum` or `vertical`, and `costUsd`
 * when the run knows it; the split's stratum is the vertical or "seed", a seed merchant having no vertical): per field the count right, the scored count and the rate, overall and per vertical, and `brandMapped`, the
 * rows whose exact code was judged on a T&E brand's generic code (printed under the table). Intervals come from
 * lanes/C1/ci.py (`wilson K N`, and `paired` for arm against arm), not from here. `teacherGroupShare` is the share of
 * teacher codes in each ISO group: 5700-7299 spans restaurants, pharmacies, direct marketing, crypto, lodging and
 * dating, so a group holding most of them makes group agreement a weak signal, and the share shows it. Rows scored with
 * stage-1 labels add `bothCorrect` (code and tier right, over the labelled rows) and `labelFallback` (the rows scored
 * on the swarm's code alone).
 */
export function summarizeMcc(rows) {
  const stage1 = rows.some((r) => 'labelFallback' in r);
  const byVertical = {};
  for (const row of rows) (byVertical[row.stratum ?? row.vertical ?? 'unknown'] ??= []).push(row);
  const groups = {};
  for (const row of rows) if (row.mccGroupTeacher) groups[row.mccGroupTeacher] = (groups[row.mccGroupTeacher] ?? 0) + 1;
  const withGroup = Object.values(groups).reduce((a, b) => a + b, 0);
  return {
    against: stage1 ? 'stage1' : 'teacher',
    overall: tally(rows, stage1),
    byVertical: Object.fromEntries(Object.entries(byVertical).sort(([a], [b]) => a.localeCompare(b)).map(([v, list]) => [v, tally(list, stage1)])),
    teacherGroupShare: Object.fromEntries(Object.entries(groups).sort(([, a], [, b]) => b - a).map(([g, k]) => [g, k / withGroup])),
  };
}
