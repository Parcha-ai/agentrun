// Checking a learned workflow, field by field, against the best answer each field has: a label, else a grade's expected
// answer, else the agent's own answer. Pure: rows and a bar in, a verdict out; no store, no settings, no secrets, no
// prose beyond each field's numbers in words. The caller turns its replays (or native turns) into rows, and stores and
// words what comes back (runner/promotion.ts decideCheck).
//
// A field passes when, on the inputs the workflow answered alone, its answers are right against the known answer:
//   - known from a label or a grade: at least `agree_min` of those inputs right, and at most `margin` under the agent's
//     own accuracy on them (a correction, where the agent was wrong, gives no free pass);
//   - known only from the agent: at least the agent's agreement with itself on that field, less `margin` (the noise
//     floor: two runs of the agent differ too), or the bar's `agree_min` when no self-agreement was measured.
// Each row's field is judged against its own best known answer, so a field with labels on some inputs is judged against
// the labels there and against the agent elsewhere, and must pass both. An input with no known answer on a field (the
// agent's answer graded wrong with none given, and the workflow said another) is unjudged there: never right, so never
// right on every field at once, and a field judged on fewer than `alone_min` of the inputs that carried it fails. The
// workflow serves only when it answered at least `alone_min` of the inputs alone, at least `agree_min` of those were
// right on every field at once (the joint floor: misses spread over several fields add up, and an unjudged field is not
// right), and every field passes; a hold names each failing field and its misses. Field names are the definition's (agree_on paths): they key Maps here, never a plain object's lookup, so a name
// Object.prototype holds (`__proto__`, `constructor`) is a field like any other.

/** Where a field's known answer came from, strongest first. */
export const KNOWN = ["label", "grade", "agent"] as const;
export type Known = (typeof KNOWN)[number];

/** One field of one input: the workflow's value and the agent's (undefined: missing, never right), and the label's and
 *  the grade's when one exists. `agrees`: how the workflow's value compared with the agent's when something other than
 *  equal values decides it (the grader's verdict on a whole answer); absent, equal JSON values agree. `agent_correct`
 *  false: a grade with no expected answer said the agent's answer was wrong, so repeating it is wrong and any other value
 *  has no known answer (unjudged). True changes nothing: the agent's answer is known as it is with no grade, at the
 *  same bar (a thumbs-up never makes the check stricter than none). */
export type FieldAnswers = {
  readonly workflow: unknown;
  readonly agent: unknown;
  readonly label?: unknown;
  readonly grade?: unknown;
  readonly agrees?: boolean;
  readonly agent_correct?: boolean;
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

/** One field's counts by where its known answer came from, and how many of the inputs that carried it had none
 *  (`unjudged`, when any). */
export type FieldTally = Partial<Record<Known, FieldCount>> & { readonly unjudged?: number };

/** What a check counted, before the bar: inputs it ran on (`n`: a skipped one is none), answered alone, answered alone
 *  with every field right (`agreed`), of those the agent's answers right on every field against the same known answers
 *  (`agent_agreed`: an answer graded wrong is the agent's miss), and each field's counts. Plain numbers, so a check that
 *  collects its inputs over time (a connected agent's turns) keeps it and adds the next rows to it. */
export type CheckTally = {
  readonly n: number;
  readonly alone: number;
  readonly agreed: number;
  readonly agent_agreed: number;
  readonly fields: Readonly<Record<string, FieldTally>>;
};

/** One field's verdict: its counts over all its inputs, each against that input's best known answer (`agent_right` over
 *  the inputs with a label or grade only: where the known answer is the agent's own, the agent is not measured), the
 *  strongest source it was known from, whether it passes, why in numbers, and the counts per source (`by`; there, an
 *  agent-known source's agent_right is its n). */
export type FieldVerdict = FieldCount & {
  /** The inputs that carried it with no known answer (judged on `n` of n + unjudged), when any. */
  readonly unjudged?: number;
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
  /** The joint floor: of the inputs answered alone, those right on every field at once, at least agree_min of them. */
  readonly joint: { readonly agreed: number; readonly alone: number; readonly pass: boolean };
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

/** Whether the workflow's value on one field is right, and the agent's, against that field's best known answer;
 *  undefined when it has none (the agent's answer graded wrong with no expected one, and the workflow said another). */
function judged(one: FieldAnswers): { known: Known; expected: unknown; workflow: boolean; agent: boolean } | undefined {
  const { value, known } = knownOf(one);
  if (known !== "agent") return { known, expected: value, workflow: right(one.workflow, value), agent: right(one.agent, value) };
  const same = one.agrees ?? right(one.workflow, one.agent);
  if (one.agent_correct === false) return same ? { known: "grade", expected: undefined, workflow: false, agent: false } : undefined;
  return { known, expected: value, workflow: same, agent: true };
}

const NO_TALLY: CheckTally = { n: 0, alone: 0, agreed: 0, agent_agreed: 0, fields: {} };

type Counting = { -readonly [K in Known]?: FieldCount } & { unjudged?: number };

/** `rows` counted, added to `before` (a check's inputs counted so far; one kept before `agent_agreed` was counted had
 *  the agent's answers as its only known ones, so the agent was right on each it answered alone). */
export function tallyOf(rows: readonly CheckInput[], before: CheckTally = NO_TALLY): CheckTally {
  let { n, alone, agreed } = before;
  let agentAgreed = before.agent_agreed ?? before.alone;
  const fields = new Map<string, Counting>(Object.entries(before.fields).map(([name, by]) => [name, countsOf(by)]));
  for (const row of rows) {
    if (row.outcome === "skipped") continue;
    n += 1;
    if (row.outcome !== "answered") continue;
    alone += 1;
    let all = true;
    let agentAll = true;
    for (const [name, one] of Object.entries(row.fields ?? {})) {
      const j = judged(one);
      const by = fields.get(name) ?? {};
      fields.set(name, by);
      if (!j) {
        // No known answer: not right, and the agent's answer was graded wrong.
        by.unjudged = (by.unjudged ?? 0) + 1;
        all = false;
        agentAll = false;
        continue;
      }
      const was = by[j.known] ?? { n: 0, workflow_right: 0, agent_right: 0 };
      by[j.known] = { n: was.n + 1, workflow_right: was.workflow_right + (j.workflow ? 1 : 0), agent_right: was.agent_right + (j.agent ? 1 : 0) };
      if (!j.workflow) all = false;
      if (!j.agent) agentAll = false;
    }
    if (all) agreed += 1;
    if (agentAll) agentAgreed += 1;
  }
  return { n, alone, agreed, agent_agreed: agentAgreed, fields: Object.fromEntries(fields) };
}

/** A field's counts, copied: only the sources KNOWN names and its unjudged count, whatever else the object holds. */
const countsOf = (by: FieldTally): Counting => ({
  ...Object.fromEntries(KNOWN.flatMap((known) => (Object.hasOwn(by, known) && by[known] ? [[known, { ...by[known] }]] : []))),
  ...(Object.hasOwn(by, "unjudged") && typeof by.unjudged === "number" && by.unjudged > 0 ? { unjudged: by.unjudged } : {}),
});

/** The misses in `rows`: each field the workflow had wrong on an input it answered alone, inputs in order. */
export function missesOf(rows: readonly CheckInput[]): Miss[] {
  return rows.flatMap((row) => row.outcome !== "answered" ? [] : Object.entries(row.fields ?? {}).flatMap(([field, one]) => {
    const j = judged(one);
    return !j || j.workflow ? [] : [{ field, input_id: row.input_id, workflow: one.workflow, expected: j.expected, known: j.known }];
  }));
}

/** At least `share` of `n`, counted in whole inputs. Bars are decimals (0.8, 0.92 - 0.02), so the product is rounded off
 *  its float noise before it is rounded up: 0.9 of 20 needs 18, never 19. */
const atLeast = (count: number, share: number, n: number): boolean => count >= Math.ceil(Math.round(share * n * 1e6) / 1e6);

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const share = (count: number, n: number): string => pct(n ? count / n : 0);

/** One source's verdict on a field: against labels or grades, at least agree_min right and within `margin` of the agent's
 *  accuracy on the same inputs; against the agent's own answers, at least the floor. */
function sourceVerdict(name: string, known: Known, count: FieldCount, bar: FieldBar): { pass: boolean; words: string } {
  const margin = bar.margin ?? DEFAULT_MARGIN;
  if (known === "agent") {
    const self = bar.self_agreement && Object.hasOwn(bar.self_agreement, name) ? bar.self_agreement[name] : undefined;
    const floor = self === undefined ? bar.agree_min : Math.max(0, self - margin);
    const pass = atLeast(count.workflow_right, floor, count.n);
    const why = self === undefined ? `the bar ${pct(floor)}` : `the floor ${pct(floor)}: the agent agrees with itself on it ${pct(self)}, less ${pct(margin)}`;
    return { pass, words: `${count.workflow_right} of ${count.n} said what the agent said (${share(count.workflow_right, count.n)}, ${why})` };
  }
  // At least agree_min of them right, and workflow_right / n >= agent_right / n - margin: the workflow may be margin * n
  // inputs under the agent, never under agree_min (where the agent was wrong too, any answer would be within the margin).
  const pass = atLeast(count.workflow_right, bar.agree_min, count.n) && count.workflow_right + Math.round(margin * count.n * 1e6) / 1e6 >= count.agent_right;
  const against = known === "label" ? "the labels" : "the grades' expected answers";
  return { pass, words: `${count.workflow_right} of ${count.n} right against ${against} (${share(count.workflow_right, count.n)}, the bar ${pct(bar.agree_min)}), the agent ${count.agent_right} (${share(count.agent_right, count.n)}; at most ${pct(margin)} under it)` };
}

/** `tally` judged on `bar`. A field passes when every source it was known from passes and it was judged on at least
 *  `alone_min` of the inputs that carried it; it fails with no input. */
export function verdictOf(tally: CheckTally, bar: FieldBar): Omit<CheckVerdict, "misses"> {
  const fields = new Map<string, FieldVerdict>();
  for (const [name, stored] of Object.entries(tally.fields)) {
    const by = countsOf(stored);
    const sources = KNOWN.filter((known) => (by[known]?.n ?? 0) > 0);
    const judgedBy = Object.fromEntries(sources.map((known) => [known, { ...by[known]!, ...sourceVerdict(name, known, by[known]!, bar) }]));
    const sum = (key: keyof FieldCount, of: readonly Known[] = sources) => of.reduce((total, known) => total + by[known]![key], 0);
    const unjudged = by.unjudged ?? 0;
    const carried = sum("n") + unjudged;
    // Judged on enough of the inputs that carried it: unknown answers never stand in for known ones.
    const enough = atLeast(sum("n"), bar.alone_min, carried);
    const pass = sources.length > 0 && sources.every((known) => judgedBy[known]!.pass) && enough;
    const words = [
      ...sources.map((known) => judgedBy[known]!.words),
      ...(unjudged ? [`judged on ${sum("n")} of ${carried} (${share(sum("n"), carried)}, the bar ${pct(bar.alone_min)}): ${unjudged} had no known answer (graded wrong, none given, and the workflow said another)`] : []),
    ];
    fields.set(name, {
      n: sum("n"), workflow_right: sum("workflow_right"), agent_right: sum("agent_right", sources.filter((known) => known !== "agent")), ...(unjudged ? { unjudged } : {}), known: sources[0] ?? "agent", pass,
      reason: words.length ? `${name}: ${words.join("; ")}` : `${name}: no input answered alone`,
      by: Object.fromEntries(sources.map((known) => [known, { ...by[known]!, pass: judgedBy[known]!.pass }])),
    });
  }
  const alone_pass = tally.alone > 0 && atLeast(tally.alone, bar.alone_min, tally.n);
  const joint = { agreed: tally.agreed, alone: tally.alone, pass: tally.alone > 0 && atLeast(tally.agreed, bar.agree_min, tally.alone) };
  const failing = [...fields].filter(([, one]) => !one.pass).map(([name]) => name);
  const serve = alone_pass && joint.pass && fields.size > 0 && failing.length === 0;
  return { verdict: serve ? "serve" : "hold", tally, alone_pass, joint, fields: Object.fromEntries(fields), failing };
}

/** Checks a workflow on `rows`, with the inputs a check counted before them (`before`), against `bar`. */
export function check(rows: readonly CheckInput[], bar: FieldBar, before?: CheckTally): CheckVerdict {
  return { ...verdictOf(tallyOf(rows, before), bar), misses: missesOf(rows) };
}
