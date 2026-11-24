// Checking a learned workflow, field by field, against the best answer each field has: a label, else a grade's expected
// answer, else the agent's own answer. Pure: rows and a bar in, a verdict out; no store, no settings, no secrets, no
// prose beyond each field's numbers in words. The caller turns its replays (or native turns) into rows, and stores and
// words what comes back (runner/promotion.ts decideCheck).
//
// A field passes when, on the inputs the workflow answered alone, its answers are right against the known answer:
//   - known from a label or a grade: within `margin` of the agent's own accuracy on the same inputs;
//   - known only from the agent: at least the agent's agreement with itself on that field, less `margin` (the noise
//     floor: two runs of the agent differ too), or the bar's `agree_min` when no self-agreement was measured.
// Each row's field is judged against its own best known answer, so a field with labels on some inputs is judged against
// the labels there and against the agent elsewhere, and must pass both. The workflow serves only when it answered at
// least `alone_min` of the inputs alone and every field passes; a hold names each failing field and its misses.

/** Where a field's known answer came from, strongest first. */
export const KNOWN = ["label", "grade", "agent"] as const;
export type Known = (typeof KNOWN)[number];

/** One field of one input: the workflow's value and the agent's (undefined: missing, never right), and the label's and
 *  the grade's when one exists. `agrees`: how the workflow's value compared with the agent's when something other than
 *  equal values decides it (the grader's verdict on a whole answer); absent, equal JSON values agree. */
export type FieldAnswers = {
  readonly workflow: unknown;
  readonly agent: unknown;
  readonly label?: unknown;
  readonly grade?: unknown;
  readonly agrees?: boolean;
};

/** One input: what the workflow did with it (`answered` alone, handed it back, failed, or skipped at a write: no evidence
 *  either way), and, when it answered alone, each field's answers. */
export type CheckInput = {
  readonly input_id: string;
  readonly outcome: "answered" | "handed_back" | "failed" | "skipped";
  readonly fields?: Readonly<Record<string, FieldAnswers>>;
};

/** The bar: the least share of inputs answered alone (`alone_min`), the floor of a field known only from the agent when
 *  no self-agreement is given (`agree_min`), how far under the agent a field may be (`margin`, default DEFAULT_MARGIN),
 *  and the agent's agreement with itself per field (0-1), where it was measured. */
export type FieldBar = {
  readonly alone_min: number;
  readonly agree_min: number;
  readonly margin?: number;
  readonly self_agreement?: Readonly<Record<string, number>>;
};

export const DEFAULT_MARGIN = 0.02;

/** A count of inputs a field was judged on, and of those how many the workflow and the agent had right. */
export type FieldCount = { readonly n: number; readonly workflow_right: number; readonly agent_right: number };

/** What a check counted, before the bar: inputs it ran on (`n`: a skipped one is none), answered alone, answered alone
 *  with every field right (`agreed`), and each field's counts by where its known answer came from. Plain numbers, so a
 *  check that collects its inputs over time (a connected agent's turns) keeps it and adds the next rows to it. */
export type CheckTally = {
  readonly n: number;
  readonly alone: number;
  readonly agreed: number;
  readonly fields: Readonly<Record<string, Partial<Record<Known, FieldCount>>>>;
};

/** One field's verdict: its counts over all its inputs (each against that input's best known answer; where that is the
 *  agent's own, the agent is right), the strongest source it was known from, whether it passes, why in numbers, and the
 *  counts per source (`by`). */
export type FieldVerdict = FieldCount & {
  readonly known: Known;
  readonly pass: boolean;
  readonly reason: string;
  readonly by: Partial<Record<Known, FieldCount & { readonly pass: boolean }>>;
};

/** One field the workflow had wrong on one input it answered alone: its value, the known one, and where that came from. */
export type Miss = { readonly field: string; readonly input_id: string; readonly workflow: unknown; readonly expected: unknown; readonly known: Known };

export type CheckVerdict = {
  readonly verdict: "serve" | "hold";
  readonly tally: CheckTally;
  /** Whether enough inputs were answered alone. */
  readonly alone_pass: boolean;
  readonly fields: Readonly<Record<string, FieldVerdict>>;
  /** The fields that failed, in their order. */
  readonly failing: readonly string[];
  readonly misses: readonly Miss[];
};

/** JSON values equal as values: keys in any order, arrays in order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((one, i) => sameValue(one, (b as unknown[])[i]));
  const [ka, kb] = [Object.keys(a as object), Object.keys(b as object)];
  return ka.length === kb.length && ka.every((key) => Object.hasOwn(b as object, key) && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** A value is right against a known one when both are there and equal; a missing value is never right. */
const right = (value: unknown, known: unknown): boolean => value !== undefined && known !== undefined && sameValue(value, known);

/** A field's best known answer on one input, and where it came from. */
function knownOf(one: FieldAnswers): { value: unknown; known: Known } {
  if (one.label !== undefined) return { value: one.label, known: "label" };
  if (one.grade !== undefined) return { value: one.grade, known: "grade" };
  return { value: one.agent, known: "agent" };
}

/** Whether the workflow's value on one field is right, and the agent's, against that field's best known answer. */
function judged(one: FieldAnswers): { known: Known; expected: unknown; workflow: boolean; agent: boolean } {
  const { value, known } = knownOf(one);
  if (known === "agent") return { known, expected: value, workflow: one.agrees ?? right(one.workflow, one.agent), agent: true };
  return { known, expected: value, workflow: right(one.workflow, value), agent: right(one.agent, value) };
}

const NO_TALLY: CheckTally = { n: 0, alone: 0, agreed: 0, fields: {} };

/** `rows` counted, added to `before` (a check's inputs counted so far). */
export function tallyOf(rows: readonly CheckInput[], before: CheckTally = NO_TALLY): CheckTally {
  let { n, alone, agreed } = before;
  const fields: Record<string, Partial<Record<Known, FieldCount>>> = Object.fromEntries(Object.entries(before.fields).map(([name, by]) => [name, { ...by }]));
  for (const row of rows) {
    if (row.outcome === "skipped") continue;
    n += 1;
    if (row.outcome !== "answered") continue;
    alone += 1;
    let all = true;
    for (const [name, one] of Object.entries(row.fields ?? {})) {
      const j = judged(one);
      const by = (fields[name] ??= {});
      const was = by[j.known] ?? { n: 0, workflow_right: 0, agent_right: 0 };
      by[j.known] = { n: was.n + 1, workflow_right: was.workflow_right + (j.workflow ? 1 : 0), agent_right: was.agent_right + (j.agent ? 1 : 0) };
      if (!j.workflow) all = false;
    }
    if (all) agreed += 1;
  }
  return { n, alone, agreed, fields };
}

/** The misses in `rows`: each field the workflow had wrong on an input it answered alone, inputs in order. */
export function missesOf(rows: readonly CheckInput[]): Miss[] {
  return rows.flatMap((row) => row.outcome !== "answered" ? [] : Object.entries(row.fields ?? {}).flatMap(([field, one]) => {
    const j = judged(one);
    return j.workflow ? [] : [{ field, input_id: row.input_id, workflow: one.workflow, expected: j.expected, known: j.known }];
  }));
}

/** At least `share` of `n`, counted in whole inputs. Bars are decimals (0.8, 0.92 - 0.02), so the product is rounded off
 *  its float noise before it is rounded up: 0.9 of 20 needs 18, never 19. */
const atLeast = (count: number, share: number, n: number): boolean => count >= Math.ceil(Math.round(share * n * 1e6) / 1e6);

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const share = (count: number, n: number): string => pct(n ? count / n : 0);

/** One source's verdict on a field: against labels or grades, the workflow within `margin` of the agent's accuracy on the
 *  same inputs; against the agent's own answers, at least the floor. */
function sourceVerdict(name: string, known: Known, count: FieldCount, bar: FieldBar): { pass: boolean; words: string } {
  const margin = bar.margin ?? DEFAULT_MARGIN;
  if (known === "agent") {
    const self = bar.self_agreement?.[name];
    const floor = self === undefined ? bar.agree_min : Math.max(0, self - margin);
    const pass = atLeast(count.workflow_right, floor, count.n);
    const why = self === undefined ? `the bar ${pct(floor)}` : `the floor ${pct(floor)}: the agent agrees with itself on it ${pct(self)}, less ${pct(margin)}`;
    return { pass, words: `${count.workflow_right} of ${count.n} said what the agent said (${share(count.workflow_right, count.n)}, ${why})` };
  }
  // workflow_right / n >= agent_right / n - margin: the workflow may be margin * n inputs under the agent.
  const pass = count.workflow_right + Math.round(margin * count.n * 1e6) / 1e6 >= count.agent_right;
  const against = known === "label" ? "the labels" : "the grades' expected answers";
  return { pass, words: `${count.workflow_right} of ${count.n} right against ${against} (${share(count.workflow_right, count.n)}), the agent ${count.agent_right} (${share(count.agent_right, count.n)}; at most ${pct(margin)} under it)` };
}

/** `tally` judged on `bar`. A field passes when every source it was known from passes; it fails with no input. */
export function verdictOf(tally: CheckTally, bar: FieldBar): Omit<CheckVerdict, "misses"> {
  const fields: Record<string, FieldVerdict> = {};
  for (const [name, by] of Object.entries(tally.fields)) {
    const sources = KNOWN.filter((known) => (by[known]?.n ?? 0) > 0);
    const judgedBy = Object.fromEntries(sources.map((known) => [known, { ...by[known]!, ...sourceVerdict(name, known, by[known]!, bar) }]));
    const sum = (key: keyof FieldCount) => sources.reduce((total, known) => total + by[known]![key], 0);
    const pass = sources.length > 0 && sources.every((known) => judgedBy[known]!.pass);
    fields[name] = {
      n: sum("n"), workflow_right: sum("workflow_right"), agent_right: sum("agent_right"), known: sources[0] ?? "agent", pass,
      reason: sources.length ? `${name}: ${sources.map((known) => judgedBy[known]!.words).join("; ")}` : `${name}: no input answered alone`,
      by: Object.fromEntries(sources.map((known) => [known, { ...by[known]!, pass: judgedBy[known]!.pass }])),
    };
  }
  const alone_pass = tally.alone > 0 && atLeast(tally.alone, bar.alone_min, tally.n);
  const failing = Object.keys(fields).filter((name) => !fields[name]!.pass);
  const serve = alone_pass && Object.keys(fields).length > 0 && failing.length === 0;
  return { verdict: serve ? "serve" : "hold", tally, alone_pass, fields, failing };
}

/** Checks a workflow on `rows`, with the inputs a check counted before them (`before`), against `bar`. */
export function check(rows: readonly CheckInput[], bar: FieldBar, before?: CheckTally): CheckVerdict {
  return { ...verdictOf(tallyOf(rows, before), bar), misses: missesOf(rows) };
}
