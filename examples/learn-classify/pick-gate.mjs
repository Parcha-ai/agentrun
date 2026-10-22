// The uncertainty gate on a served workflow's code pick (research/PREREG-armF-gated.md, signal kind `jev-margin`, 02 §6(e)).
// After the host's run of a workflow completes with a valid answer, ONE Jev pick, independent of the workflow's code step,
// chooses among every code of the served code's own group, as the label tool groups them. Its state is the job input and
// the workflow's output with the code and its cite left out. The margin m is the served code's probability minus the
// strongest sibling's; under τ the field goes back to the agent through the host's escalation hand-off, which names no
// code. A served code the run read on its registry's own record (a receipt) is never gated: a record outranks a
// judgment. A pick that gives no probabilities is no signal, and no signal is gated.

export const PICK_QUESTION = "Which of these codes is the company filed under? The state holds the job's input and what a workflow found about the company in its own annual report; choose the code whose title says what the company does.";

/** The workflow's output without the code field and without the cites of the code's claim. */
export function strippedOutput(output, { key, claim }) {
  const { [key]: _code, ...rest } = output ?? {};
  return Array.isArray(rest.cites) ? { ...rest, cites: rest.cites.filter((c) => c?.claim !== claim) } : rest;
}

/** The served option's probability minus the largest other option's, rounded to 4 places; null without probabilities. */
export function marginOf(probabilities, served) {
  if (!probabilities || typeof probabilities !== 'object') return null;
  const others = Object.entries(probabilities).filter(([option]) => option !== served).map(([, p]) => (Number.isFinite(p) ? p : 0));
  const own = Number.isFinite(probabilities[served]) ? probabilities[served] : 0;
  return Math.round((own - (others.length ? Math.max(...others) : 0)) * 1e4) / 1e4;
}

const optionKey = (code) => `c${code}`;

/**
 * The gate on one served answer. `key` and `claim` name the answer's code field and its cites' claim; `groupOf(code)` is
 * the label tool's group of a code and `optionsOf(group)` its codes, each `{ code, name }`; `judge` is a metered judge;
 * `receipt()` says whether the run holds a receipt for the served code. Returns `{ gated, stripped, record }`: `record` is
 * what the row keeps (`{ key, group, tau, gated, m?, top?, options?, exempt? }`).
 */
export async function gatePick({ output, input, key, claim, groupOf, optionsOf, judge, tau, receipt = async () => false }) {
  const served = output?.[key];
  const group = groupOf(served);
  const stripped = strippedOutput(output, { key, claim });
  const base = { key, group, tau };
  if (await receipt()) return { gated: false, stripped, record: { ...base, gated: false, exempt: 'receipt' } };
  const options = await optionsOf(group);
  if (options.length < 2) return { gated: false, stripped, record: { ...base, gated: false, m: 1, options: options.length } };
  const criteria = Object.fromEntries(options.map((o) => [optionKey(o.code), `${o.code} ${o.name}`]));
  let m = null;
  let top = null;
  try {
    const result = await judge.run({ label: 'gate/pick', kind: 'judge', state: { company: input?.name ?? null, input, answer: stripped }, questions: { pick: { type: 'choice', instructions: PICK_QUESTION, criteria } } });
    const answer = result?.answers?.pick;
    m = served !== undefined && optionKey(served) in criteria ? marginOf(answer?.probabilities, optionKey(served)) : null;
    top = typeof answer?.choice === 'string' ? answer.choice.replace(/^c/, '') : null;
  } catch {
    m = null;
  }
  const gated = m === null || m < tau;
  return { gated, stripped, record: { ...base, gated, m, top, options: options.length } };
}
