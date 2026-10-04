// Fictional data and a scripted judge for the ranking example. The scores and duplicate verdicts are
// fixed, so the example exercises the interpreter; it does not measure how well a model ranks.

const proposal = (id, bucket, title, summary) => ({ id, bucket, title, summary });

export const request = {
  brief: 'A one-day programme for engineers who run agent workflows in production: what breaks, how to see it, and how to keep cost and latency in hand.',
  top: 5,
  perBucket: 2,
  minScore: 1.5,
  candidates: [
    proposal('p01', 'reliability', 'What we learned from 400 failed runs', 'A taxonomy of production failures in agent workflows and the checks that caught each one.'),
    proposal('p02', 'reliability', 'Retries that do not repeat side effects', 'Idempotency keys, uncertain outcomes and when a retry is safe.'),
    proposal('p03', 'reliability', 'A field guide to agent workflow failures', 'Failure classes seen in production runs and how each was detected.'),
    proposal('p04', 'observability', 'Traces you can replay', 'Recording every model call and tool call so a run can be inspected and rerun.'),
    proposal('p05', 'observability', 'Dashboards nobody reads', 'Which workflow metrics changed a decision, and which only filled a wall.'),
    proposal('p06', 'cost', 'Pricing a loop before it runs', 'Estimating spend for bounded loops and maps, and stopping on a budget.'),
    proposal('p07', 'cost', 'Small models for typed judgments', 'Moving routing and screening decisions off the large model.'),
    proposal('p08', 'cost', 'Latency budgets for interactive workflows', 'Where the seconds go between a request and the first useful step.'),
    proposal('p09', 'reliability', 'Timeouts, deadlines and clocks', 'Why a one-second deadline fired at 999 ms, and other timer surprises.'),
    proposal('p10', 'community', 'Naming your open-source project', 'How we chose a name and a logo.'),
    proposal('p11', 'community', 'Our team offsite in pictures', 'Photos and stories from this year.'),
    proposal('p12', 'observability', 'Evidence, not vibes', 'Keeping the source text next to every automated decision.'),
  ],
};

// Expected levels on the 0–3 fit scale, as a judge might score them against the brief.
export const fitScores = {
  p01: 2.92, p02: 2.71, p03: 2.88, p04: 2.64, p05: 1.83, p06: 2.58,
  p07: 2.31, p08: 2.47, p09: 2.68, p10: 0.21, p11: 0.04, p12: 2.26,
};

// Pairs a judge would call the same talk. p03 covers the same ground as p01.
export const duplicatePairs = [['p01', 'p03']];

const round2 = (n) => Math.round(n * 100) / 100;

/** A Score answer whose distribution has the given expected level, rounded to two places the way
 *  System One reports it. */
export function scoreAnswer(question, expected) {
  const last = question.criteria.length - 1;
  const low = Math.min(last - 1, Math.floor(expected));
  const high = round2(expected - low);
  const probabilities = Object.fromEntries(question.criteria.map((_, level) => [String(level), level === low ? round2(1 - high) : level === low + 1 ? high : 0]));
  return {
    type: 'score', score: round2(low * probabilities[String(low)] + (low + 1) * high), confidence: round2(Math.abs(high - 0.5) * 2),
    probabilities, legend: Object.fromEntries(question.criteria.map((text, level) => [String(level), text])),
  };
}

/** A scripted `runJudge`. It reads each item from the state it was sent, so a request that carried
 *  the wrong items would produce the wrong ranking. */
export function createScriptedJudge({ scores = fitScores, duplicates = duplicatePairs } = {}) {
  const requests = [];
  const runJudge = async ({ label, state, questions }) => {
    // Called from another workflow, a step's label carries the caller's path: "rank-proposals/score-fit".
    const step = label.split('/').at(-1);
    requests.push({ label: step, questions: Object.keys(questions).length });
    const answers = {};
    for (const [key, question] of Object.entries(questions)) {
      const item = state.items[Number(key.split('.')[0])].item;
      if (step === 'score-fit') answers[key] = scoreAnswer(question, scores[item.id] ?? 0);
      else if (step === 'find-duplicates') {
        const same = duplicates.some(([a, b]) => (a === item.keep.id && b === item.other.id) || (b === item.keep.id && a === item.other.id));
        answers[key] = { type: 'noul', noul: same ? 0.94 : 0.03 };
      } else throw new Error(`No scripted judgment for ${label}.`);
    }
    return { answers, model: 'scripted', cost_usd: 0 };
  };
  return { runJudge, requests };
}
