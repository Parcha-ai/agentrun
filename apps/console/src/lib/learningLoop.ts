// The self-learning loop as the Learning tab tells it: the agent learned notes, compiled them into a workflow, the
// workflow took over (promoted by one check on the inputs of the agent's own runs), and runs got cheaper, with how often
// it handed back. The arithmetic here reads the server's records only (GET .../learning/cost, .../promotions,
// .../loop, .../workflows/{name}/revisions); nothing is simulated and nothing says more than they do.
import type { CostRun, LearningCost, LearningLoop, Promotion, Serving } from "./v2";

/** When a job compiles into a workflow (serve learning-setting.ts COMPILE_AFTER_DEFAULT): at this many completed runs
 *  with no workflow yet, unless the agent's definition sets `learning.compile_after`. */
export const COMPILE_AFTER_DEFAULT = 20;
/** The completed runs an agent's job compiles at: its definition's `learning.compile_after`, else the default. */
export const compileAfterOf = (learning: unknown): number => {
  const set = typeof learning === "object" && learning !== null ? (learning as { compile_after?: unknown }).compile_after : undefined;
  return typeof set === "number" && Number.isInteger(set) && set >= 1 ? set : COMPILE_AFTER_DEFAULT;
};
/** A takeover's "N times cheaper" needs this many runs after it (serve learning-cost.ts CHEAPER_AFTER_RUNS). */
export const CHEAPER_AFTER = 20;

/** A marker on the cost chart's run axis, from a promotion record: a new revision replaying, promoted or held. */
export type MarkerKind = "revision" | "promote" | "hold";
export type Marker = { kind: MarkerKind; n: number; at: string; workflow: string; digest: string; reason: string; record: Promotion };
export const MARKER_WORDS: Record<MarkerKind, string> = { revision: "New revision", promote: "Promoted", hold: "Held" };
/** One letter per kind, drawn in the marker's flag so a kind is never told by colour alone. */
export const MARKER_LETTER: Record<MarkerKind, string> = { revision: "R", promote: "P", hold: "H" };

/** A promotion record's kind of marker: a replay that started, a new revision; else its decision. */
export const kindOf = (record: Promotion): MarkerKind => (record.decided === "replaying" ? "revision" : record.decided);

/** Each promotion record on the run axis: at the first run (of `runs`, in order) that started at or after it, the run it
 *  first bore on. One newer than the last run is left out (no run of the axis is its), and so is one older than the first
 *  run read. Every record keeps its own marker, even two of one kind on one run (two workflows promoted between two
 *  runs): the chart stacks their flags in rows. */
export function markersOf(runs: readonly CostRun[], records: readonly Promotion[]): Marker[] {
  if (!runs.length) return [];
  const starts = runs.map((r) => Date.parse(r.started_at));
  const first = starts[0]!;
  const out: Marker[] = [];
  for (const record of records) {
    const t = Date.parse(record.at);
    if (!Number.isFinite(t) || t < first - 1) continue;
    const i = starts.findIndex((s) => s >= t);
    if (i < 0) continue;
    const kind = kindOf(record);
    const n = runs[i]!.n;
    out.push({ kind, n, at: record.at, workflow: record.workflow, digest: record.digest, reason: record.reason, record });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** A run that counts in what a job costs: every run but a replay (a revision run alone on an input before it serves). */
export const counted = (r: CostRun) => r.path !== "replay";

/** How often the workflow handed the run back since it took over: the server's count over every run since (the cost
 *  summary's `hand_backs`), never the latest runs a read lists. Null before a takeover or with none since. */
export const handBacksOf = (cost: Pick<LearningCost, "summary"> | null): { ran: number; back: number } | null =>
  cost?.summary.hand_backs?.ran ? cost.summary.hand_backs : null;

/** The newest promotion record of one revision (`workflow` at `digest`): what it is now. */
export const recordOf = (records: readonly Promotion[], workflow: string, digest: string | null): Promotion | undefined =>
  digest === null ? undefined : [...records].reverse().find((r) => r.workflow === workflow && r.digest === digest);

/** A revision's standing in words a person reads: Serving (it is the champion: `serving`, the digest the server says
 *  serves), Served (promoted once, a newer one serves now), Held, Replaying, or not decided yet. A held or replaying
 *  revision never stops its champion serving. Stopped when it is the champion but the money rule stopped it
 *  running first (`stopped`, the digest the cost read says `needs_revision`: stoppedOf); no promotion record says so.
 *  `proof`: what a promoted or held revision was decided on (proofOf), said beside its word; a revision serving with no
 *  check input behind it (an owner's approval) is never green. */
export type Standing = { word: "Serving" | "Stopped" | "Served" | "Held" | "Replaying" | "Not decided"; tone: "success" | "warning" | "active" | "muted" | "plain"; proof?: string; text: string };
function standingBase(record: Promotion | undefined, { serving = null, stopped = null }: { serving?: string | null; stopped?: string | null } = {}): Omit<Standing, "text"> {
  if (!record) return { word: "Not decided", tone: "muted" };
  const proof = proofOf(record);
  const said = proof ? { proof } : {};
  if (record.decided === "promote") return record.digest !== serving ? { word: "Served", tone: "muted", ...said } : record.digest === stopped ? { word: "Stopped", tone: "warning", ...said } : { word: "Serving", tone: proven(record) ? "success" : "plain", ...said };
  if (record.decided === "hold") return { word: "Held", tone: "warning", ...said };
  return { word: "Replaying", tone: "active" };
}
/** The standing with its chip text: the word, then " · " and its proof. Every chip of a standing says `text`. */
export function standingOf(...args: Parameters<typeof standingBase>): Standing {
  const base = standingBase(...args);
  return { ...base, text: base.proof ? `${base.word} · ${base.proof}` : base.word };
}

/** The digest of `workflow` the money rule stopped running first (the cost read's `needs_revision`: over its last runs it
 *  cost as much as the agent by hand), or null. */
export const stoppedOf = (cost: Pick<LearningCost, "workflows"> | null, workflow: string): string | null =>
  cost?.workflows.find((one) => one.workflow === workflow && one.state === "needs_revision")?.digest ?? null;

/** What a promotion record was decided on, in a few words beside "Promoted" or "Serving": "checked on 18 inputs · 9
 *  alone" (the inputs of the agent's own runs its one check ran on, and how many it answered alone); null for one still
 *  replaying, or one its check ran on no input (nothing to check it on, or a draft that failed its checks: its reason
 *  says). Owner approval of the file is never proof. */
export function proofOf(record: Promotion): string | null {
  const c = record.check;
  if (!c?.n || (record.decided !== "promote" && record.decided !== "hold")) return null;
  return `checked on ${c.n} ${c.n === 1 ? "input" : "inputs"} · ${c.alone ?? 0} alone`;
}

/** Whether a record was decided on evidence: its check ran on at least one input. */
export const proven = (record: Promotion): boolean => (record.check?.n ?? 0) > 0;

const pctOf = (v: number) => `${Math.round(v * 100)}%`;

/** A record's numbers in one line: "Checked on 20 inputs of the agent's own runs: 18 answered alone (90%, 70% needed),
 *  16 of those said what the agent said (89%, 80% needed)". A record its check ran on no input says its reason. */
export function replayLine(record: Promotion): string {
  const c = record.check;
  if (!c?.n) return record.reason;
  const alone = c.alone ?? 0;
  const agreed = c.agreed ?? 0;
  return `Checked on ${c.n} ${c.n === 1 ? "input" : "inputs"} of the agent's own runs: ${alone} answered alone (${pctOf(alone / c.n)}, ${pctOf(c.alone_min)} needed), ${agreed} of those said what the agent said (${alone ? pctOf(agreed / alone) : "0%"}, ${pctOf(c.agree_min)} needed)${c.outcomes?.handed_back ? `, ${c.outcomes.handed_back} handed back` : ""}`;
}

/** The workflow a note was compiled into, from its front matter (`compiled_into: <workflow>`): null when none. */
export function compiledInto(text: string): string | null {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!head) return null;
  const line = head[1]!.split(/\r?\n/).find((l) => /^compiled_into\s*:/.test(l));
  const value = line?.replace(/^compiled_into\s*:\s*/, "").trim().replace(/^["']|["']$/g, "");
  return value ? value : null;
}

/** Where the loop stands, as the story strip says it: each stage's state and its words, and what happens next. */
export type Stage = { key: "notes" | "compiled" | "took_over" | "cheaper" | "unsure"; title: string; value: string; detail: string; state: "done" | "now" | "later" | "warn" | "watch" };
export function storyOf(input: {
  notes: number; compiledNotes: number; runs: number; workflows: { name: string; status: string }[];
  cost: LearningCost | null; promotions: readonly Promotion[]; serving: readonly Serving[]; loop: LearningLoop | null;
  /** The agent's learning: `notes` keeps notes and never compiles (the runner skips the compile turn), so the story
   *  promises no workflow, takeover or cheaper runs it will never get. */
  mode?: "full" | "notes";
  /** Native runs learn notes/skills; SDK workflows run only through their backend-owned bridge. */
  execution?: "hosted" | "native" | "sdk";
  /** The completed runs its job compiles at (compileAfterOf the definition's `learning`). */
  compileAfter?: number;
}): Stage[] {
  const { notes, compiledNotes, runs, workflows, cost, promotions, serving, loop, mode = "full", execution = "hosted", compileAfter = COMPILE_AFTER_DEFAULT } = input;
  const notesOnly = mode === "notes";
  const active = workflows.filter((w) => w.status === "active");
  const failedCompile = loop?.compiles.find((c) => c.digest === null && (c.draft_errors.length > 0 || c.attempts.length > 0));
  // The newest compile that wrote a workflow the checks passed (a later refused draft says so in the feed).
  const lastCompile = loop?.compiles.find((c) => c.digest !== null);
  const s = cost?.summary;
  const back = handBacksOf(cost);
  const newest = promotions.at(-1);
  // What the newest record's workflow serves: its champion keeps serving while a newer revision replays or after it is held.
  const now = newest ? serving.find((one) => one.workflow === newest.workflow) : undefined;
  const champion = now?.digest ?? null;
  const challenger = now?.replaying ? `revision ${now.replaying.slice(0, 7)} is checked on the inputs of its agent's own runs before it serves` : newest?.decided === "hold" && newest.digest !== champion ? `revision ${newest.digest.slice(0, 7)} was held: ${replayLine(newest)}` : null;
  // The champion the money rule stopped running first (the cost read's needs_revision): no promotion record says so.
  const stopped = champion !== null && newest ? stoppedOf(cost, newest.workflow) === champion : false;
  const stoppedLine = stopped ? `revision ${champion!.slice(0, 7)} no longer runs first: it cost as much as the agent by hand; the agent takes its runs` : null;
  const servingLine = stoppedLine ? (challenger ? `${stoppedLine}; ${challenger}` : stoppedLine) : champion && challenger ? `revision ${champion.slice(0, 7)} serves; ${challenger}` : null;
  const stages: Stage[] = [];
  stages.push({
    key: "notes", title: "Learned", value: notes === 1 ? "1 note" : `${notes} notes`,
    detail: compiledNotes ? `${compiledNotes} compiled into a workflow` : notes ? "kept from its runs, read by every later run" : "none yet: a run keeps what it learns at its end",
    state: notes ? "done" : "now",
  });
  if (execution === "native") {
    stages.push({ key: "compiled", title: "Learning", value: "Notes and skills", detail: "Native runs receive accepted notes and skills; learned workflows are unavailable.", state: "later" });
    return stages;
  }
  if (active.length || (lastCompile && lastCompile.digest)) {
    const name = active[0]?.name ?? lastCompile?.workflow ?? "a workflow";
    stages.push({ key: "compiled", title: "Compiled", value: name, detail: lastCompile ? `from ${lastCompile.from_notes.length} ${lastCompile.from_notes.length === 1 ? "note" : "notes"}, ${lastCompile.attempts.length} ${lastCompile.attempts.length === 1 ? "attempt" : "attempts"}` : "a learned workflow", state: "done" });
  } else if (failedCompile) {
    stages.push({ key: "compiled", title: "Compile", value: "Draft failed", detail: `${failedCompile.attempts.length} ${failedCompile.attempts.length === 1 ? "attempt" : "attempts"}, the checks refused it: it tries again on a later run`, state: "warn" });
  } else if (notesOnly) {
    stages.push({ key: "compiled", title: "Compile", value: "Notes only", detail: `this agent learns notes only: no workflow compiles from them. Full learning compiles one at ${compileAfter} completed runs`, state: "later" });
  } else {
    stages.push({ key: "compiled", title: "Compile", value: "Not yet", detail: execution === "sdk" ? `With workflow learning and backend tool bindings, compilation starts at ${compileAfter} completed runs` : `${Math.min(runs, compileAfter)} of ${compileAfter} completed runs: a workflow compiles at ${compileAfter}, then is checked once on those runs' inputs against the agent's own answers`, state: runs ? "now" : "later" });
  }
  if (execution === "sdk") {
    if (!notesOnly) stages.push({ key: "took_over", title: "Use workflow", value: "Backend decides", detail: "Your backend keeps launching each run. The SDK can call accepted workflows through MCP with explicitly bound tools.", state: active.length ? "now" : "later" });
    return stages;
  }
  if (s?.takeover) {
    stages.push({ key: "took_over", title: "Took over", value: `Run ${s.takeover.n}`, detail: servingLine ?? (newest?.check?.n ? replayLine(newest) : newest ? newest.reason : "the first run a learned workflow finished alone"), state: stopped || (newest?.decided === "hold" && !champion) ? "warn" : "done" });
  } else if (newest) {
    if (servingLine) stages.push({ key: "took_over", title: "Take over", value: standingOf(recordOf(promotions, newest.workflow, champion) ?? newest, { serving: champion, stopped: stopped ? champion : null }).word, detail: servingLine, state: stopped ? "warn" : "done" });
    else {
      const st = standingOf(newest, { serving: champion });
      stages.push({ key: "took_over", title: "Take over", value: st.word, detail: newest.decided === "replaying" ? "being checked on the inputs of the agent's own runs before it serves; the agent takes the runs meanwhile" : replayLine(newest), state: newest.decided === "hold" ? "warn" : "now" });
    }
  } else if (!notesOnly) {
    stages.push({ key: "took_over", title: "Take over", value: "Not yet", detail: "a compiled workflow is checked once on the inputs of the agent's own runs, then serves first when it clears the check's bar", state: "later" });
  }
  if (s?.takeover && s.withheld) {
    stages.push({ key: "cheaper", title: "Cheaper", value: "No ratio yet", detail: `${withheldWords(s.withheld)}: ${WITHHELD_NEXT}`, state: "now" });
  } else if (s?.after && s.before) {
    // The after side is the runs the workflow served (alone or handed back), never its replays: said with its count.
    const words = `${dollars(s.before.mean_usd)} a run by the agent, ${dollars(s.after.mean_usd)} all-in over the ${s.after.runs === 1 ? "1 run" : `${s.after.runs} runs`} it served since`;
    const ratio = s.times_cheaper;
    if (ratio !== null && ratio > 1) stages.push({ key: "cheaper", title: "Cheaper", ...cheaperClaim(s, ratio), state: "done" });
    // times_cheaper is rounded by the server (0.03 reads as 0), so the increase comes from the two means.
    else if (ratio !== null) stages.push({ key: "cheaper", title: "Cheaper", value: ratio < 1 ? (s.before.mean_usd > 0 ? `Not cheaper yet: ${timesWord(s.after.mean_usd / s.before.mean_usd)} the cost` : "Not cheaper yet") : "Same cost", detail: words, state: "now" });
    else stages.push({ key: "cheaper", title: "Cheaper", value: `${s.after.runs} served ${s.after.runs === 1 ? "run" : "runs"} so far`, detail: `${words}; how many times cheaper shows after ${CHEAPER_AFTER} runs`, state: "now" });
  } else if (s?.takeover && s.after_state === "cost_unknown") {
    stages.push({ key: "cheaper", title: "Cheaper", value: "No cost yet", detail: "no served run's cost is known yet", state: "now" });
  } else if (s?.after) {
    // Served runs exist; what is missing is the agent's own priced runs before the takeover to set them against.
    stages.push({ key: "cheaper", title: "Cheaper", value: `${s.after.runs} served ${s.after.runs === 1 ? "run" : "runs"} so far`, detail: `${dollars(s.after.mean_usd)} all-in over the ${s.after.runs === 1 ? "1 run" : `${s.after.runs} runs`} it served; no priced agent runs before takeover to compare with`, state: "now" });
  } else if (!notesOnly) {
    stages.push({ key: "cheaper", title: "Cheaper", value: "Not yet", detail: "no served runs yet: once a workflow takes over, the all-in cost of the runs it serves against before (replays are checks, not served runs)", state: "later" });
  }
  if (back) {
    stages.push({ key: "unsure", title: "Unsure", value: `${Math.round((back.back / back.ran) * 100)}% handed back`, detail: `of ${back.ran} runs it ran first`, state: back.back / back.ran > 0.25 ? "warn" : "watch" });
  }
  return stages;
}

/** Why the cost summary has no times-cheaper figure (its `withheld`): "3 runs' cost unknown, 1 known only as at most". */
export function withheldWords(w: { unknown: number; at_most: number }): string {
  const runs = (n: number) => `${n} ${n === 1 ? "run's" : "runs'"} cost`;
  if (!w.unknown) return `${runs(w.at_most)} known only as at most`;
  return `${runs(w.unknown)} unknown${w.at_most ? `, ${w.at_most} known only as at most` : ""}`;
}
export const WITHHELD_NEXT = "how many times cheaper shows once every run's cost is known";

/** The tab's cheaper headline over a ratio above 1: "About Nx cheaper" and what its check showed when the serving
 *  champion's check cleared (the cost summary's `replay`): it passed the agreement check, N of the M inputs it answered
 *  alone agreeing with the agent against the bar, and what was served under it. Never "the same accuracy": passing the
 *  bar is all it says. Else the ratio alone, and why accuracy is not claimed. */
function cheaperClaim(s: LearningCost["summary"], ratio: number): { value: string; detail: string } {
  const n = ratio >= 1.5 ? `${Math.round(ratio)}x` : `${ratio.toFixed(1)}x`;
  const r = s.replay;
  const scored = r ? `workflow ${Math.round(r.workflow_pct)}% vs agent ${Math.round(r.agent_pct)}% on ${r.n} inputs` : "";
  if (r?.cleared) {
    const served = s.hand_backs ? ` · served ${s.hand_backs.ran} ${s.hand_backs.ran === 1 ? "run" : "runs"}, handed back ${s.hand_backs.back}` : "";
    return { value: `About ${n} cheaper`, detail: `Passed the agreement check: ${r.agreed} of ${r.alone} agreed (bar ${Math.round(r.agree_min * 100)}%)${served}` };
  }
  return { value: `${n} cheaper`, detail: `accuracy not claimed: ${r ? `its check was below the bar (${scored})` : "no check yet"}` };
}

/** A dollar level as the chart says it (costPerRun.ts level): three figures under a dollar. */
const dollars = (v: number) => (v === 0 ? "$0" : v < 0.0001 ? "<$0.0001" : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(3)}`);
const timesWord = (ratio: number) => { const t = Math.round(ratio * 10) / 10; return `${t >= 10 ? Math.round(ratio) : t.toFixed(1)}x`; };
