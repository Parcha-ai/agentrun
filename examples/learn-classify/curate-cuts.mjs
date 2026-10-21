// The curator's judge cuts this host runs with, and a judge that never lets a held text in on a kinder answer later.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** The cuts pre-registered for the stream (v0.1): fixed on the recorded lessons and 20 injection controls before any DEV
 *  run. A probability at or above `yes` is a yes, at or below `no` a no, and anything between holds the candidate. */
export const CURATE_CUTS_V01 = Object.freeze({
  fromContent: Object.freeze({ yes: 0.8, no: 0.65 }),
  narrowsRules: Object.freeze({ yes: 0.6, no: 0.45 }),
  general: Object.freeze({ yes: 0.6, no: 0.4 }),
});

/** The worse direction of each atomic question about one learning: a higher probability is worse for the first two. */
const WORSE = Object.freeze({ fromContent: Math.max, narrowsRules: Math.max, general: Math.min });
/** How far an answer must clear when the cuts change and the text was judged under the old ones. */
const RECUT_MARGIN = 0.05;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const round = (p) => Math.round(p * 1e6) / 1e6;

/** A learning's text as one key: Unicode compatibility forms, case and runs of whitespace do not make a new text. */
export const textKey = (text) => sha256(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim());

/**
 * Wraps a `runJudge` port so that each atomic question about a learning's text answers with the worst probability ever
 * seen for that text: the highest for fromContent and narrowsRules (narrowsRules per rules text), the lowest for general.
 * A text curation held once can then only stay held or be refused, whatever a later answer says. Every other question
 * passes through. The store is a JSON file beside the agent repository. Under a new `cutsId` the old worst values are
 * dropped, and a text judged under the old cuts must clear the new ones by `RECUT_MARGIN`.
 */
export function stickyJudge(judge, { file, cutsId }) {
  const loaded = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, cutsId, worst: {} };
  const store = { version: 1, cutsId, worst: loaded.cutsId === cutsId ? { ...loaded.worst } : {} };
  const prior = new Set(loaded.cutsId === cutsId ? [] : Object.keys(loaded.worst));
  const save = () => {
    writeFileSync(`${file}.pending`, `${JSON.stringify(store, null, 1)}\n`);
    renameSync(`${file}.pending`, file);
  };
  return async (params) => {
    const result = await judge(params);
    const questions = Object.keys(params?.questions ?? {});
    const text = params?.state?.learning?.text;
    const q = questions.length === 1 ? questions[0] : undefined;
    const worse = q ? WORSE[q] : undefined;
    const p = q ? result?.answers?.[q]?.noul : undefined;
    if (!worse || typeof text !== 'string' || typeof p !== 'number') return result;
    const key = `${q}:${textKey(text)}${q === 'narrowsRules' ? `:${sha256(String(params.state.rules ?? ''))}` : ''}`;
    let held;
    if (key in store.worst) held = worse(store.worst[key], p);
    else if (prior.delete(key)) held = worse === Math.max ? Math.min(1, p + RECUT_MARGIN) : Math.max(0, p - RECUT_MARGIN);
    else held = p;
    store.worst[key] = round(held);
    save();
    return { ...result, answers: { ...result.answers, [q]: { ...result.answers[q], noul: store.worst[key] } } };
  };
}
