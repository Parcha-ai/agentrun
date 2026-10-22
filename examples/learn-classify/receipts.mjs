// ARM C, "learn-receipt" (01-loop.md 1.17): admission and promotion by receipt. A run's receipt (eval-lookup.mjs
// receiptOf) is the run having read the SEC's own record of the code it answered and cited it. With it, the run's lessons
// and facts are judged with fromContent answered by the receipt instead of the judge; every other question, the guard and
// the sticky scores apply as always. A trial revision that reaches an archived SEC page and was born in, or ran in, a run
// with a receipt is a receipt candidate: it is put to the bank gate at once, ahead of any other comparison.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { textKey } from './curate-cuts.mjs';
import { revisionCarriesLookup } from './eval-lookup.mjs';

/**
 * The judge port with fromContent answered by the run's receipt for the texts in `texts` (textKey of each lesson and fact
 * of a run that holds one): the answer is 0, marked `receipt`, and the judge is not asked. Every other question, and every
 * other text, goes to `judge`.
 */
export function receiptJudge(judge, texts) {
  return async (params) => {
    const q = Object.keys(params?.questions ?? {});
    const text = params?.state?.learning?.text;
    if (q.length === 1 && q[0] === 'fromContent' && typeof text === 'string' && texts.has(textKey(text))) {
      return { answers: { fromContent: { type: 'noul', noul: 0, receipt: true } }, cost_usd: 0 };
    }
    return judge(params);
  };
}

/** The textKeys of a run's lesson and fact candidates (finishJob's `candidates`). */
export const receiptTextsOf = (candidates) => new Set((candidates ?? []).filter((c) => c.type === 'lesson' || c.type === 'fact').map((c) => textKey(c.text)));

/** What the host keeps per run for promotion by receipt, in <dir>/<run>.json: its receipt, the revisions it ran, whether
 *  a workflow's node read an archived SEC page, and the revisions it saved. */
export function recordRun(dir, record) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${record.run}.json`);
  writeFileSync(`${file}.pending`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${file}.pending`, file);
}

const runsIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : []);

/**
 * Whether trial revision `sha256` (admitted by run `bornIn`, its document `workflow`) is a receipt candidate, from the
 * runs recorded under `dir`: born in a run with a receipt, or run in one, and reaching an archived SEC page, by a call node
 * whose address is one (revisionCarriesLookup) or by a node seen reading one in a run that ran it.
 */
export function isReceiptCandidate(dir, { sha256, bornIn, workflow }) {
  const runs = runsIn(dir);
  const ran = runs.filter((r) => (r.executed ?? []).includes(sha256));
  const receiptRun = runs.some((r) => r.run === bornIn && r.receipt) || ran.some((r) => r.receipt);
  const reaches = revisionCarriesLookup(workflow) || ran.some((r) => r.workflowTouch);
  return receiptRun && reaches;
}
