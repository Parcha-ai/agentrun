// The counters strip (RECORDING.md section 6), one fold for every recording. Counts come from durable lines, and
// processes and kills from the supervisor's host lines; a count only live lines can give is "observed".
import type { Json, Line } from './format.ts';
import type { Fold } from './replay.ts';
import {
  applied, browserChargesOf, callsOf, costOf, lookChargesOf, decisionRowsOf, docIdOf, docOf, effectOf, entryOf, generationOf, liveGenerationOf, receiptCountOf, stableJson, toolCallsOf,
  type Effect,
} from './durable.ts';
import { receiptKeyOf } from './receipt-key.ts';

/** A run key's decision rows: the answered ones by `<run_key> <decision_id>`, the failed count, and each row's cost. */
type Tally = { answered: string[]; failed: number; cost: (number | null)[] };
/** A value's revisions in the branch the store holds, as [commit, value]: a restore subtracts the value as of its
 *  checkpoint from the latest, and what is left is what the lost branch did. */
type History<T> = [number, T][];
const asOf = <T>(history: History<T>, commit: number) => history.findLast(([at]) => at <= commit)?.[1];
const ZERO: Tally = { answered: [], failed: 0, cost: [] };
/** The `pi.live` version the ask fold was measured on (pi-durable 1.1.0): another version reads re-asked not measured. */
export const PI_LIVE_VERSION = 1;

export type CounterState = {
  effects: Record<string, { admitted: number | undefined; status: Effect['status']; completedAt?: number }>;
  receipts: Record<string, History<number>>;
  /** Per effect, the generation of each `applied` outside call, in order, a lost branch included: never reset. */
  appliedIn: Record<string, number[]>;
  /** Per effect, the list its previous line carried (each call as stable JSON): a line's new calls are those beyond it. */
  listed: Record<string, string[]>;
  /** Every effect seen, and those whose host reported calls: an effect with none has repeated not measured. */
  effectsSeen: Record<string, true>;
  reported: Record<string, true>;
  /** The receipt keys (`<tool>:<argsHash>`) the run held at any point: a tool call under one is a paid call. */
  paidKeys: Record<string, true>;
  /** An agent's tool call id to its receipt key, and each executed result (not reused, not refused) by key. */
  toolCalls: Record<string, string>;
  executions: { key: string; gen: number }[];
  /** What a lost branch (RECORDING.md 3.2) completed or asked: paid, though no store holds it any more. */
  lostPaid: number;
  lostAgent: number;
  lostJudge: Tally;
  highest: number;
  /** At a restore, what the store held at its checkpoint, for the restored snapshot to rebuild from (so a later
   *  restore to an older checkpoint still finds it): each effect's completion commit, and each receipt's and decision's
   *  history up to the checkpoint. Cleared when the snapshot ends. */
  retained?: { effects: Record<string, number>; receipts: Record<string, History<number>>; decisions: Record<string, History<Tally>>; charges: Record<string, History<number | null>> };
  /** Whether the last durable line was a snapshot, and whether a process started since the last snapshot line: a
   *  process's snapshot is the run it writes at its open (3.2). */
  inSnapshot: boolean;
  opened: boolean;
  decisions: Record<string, History<Tally>>;
  committedTurns: Record<string, number>;
  /** The model part of cost: unknown until an assistant entry prices it, and unknown again when one carries no price. */
  modelCost: number;
  modelCostKnown: boolean;
  modelPriced: boolean;
  /** Whether any durable line was folded: with none, no count here is measured. */
  measured: boolean;
  /** The other priced parts of cost, per session or look in the branch the store holds: a browser session's charge
   *  and a vision look's (each a running total), null until priced. A restore sets them back to the checkpoint's, and
   *  what the lost branch charged beyond it stays in lostCharges (null when a lost part is unknown). */
  charges: Record<string, History<number | null>>;
  lostCharges: number | null;
  /** Per conversation, the `pi.live` generation last seen and the ask open there: its position (the non-aborted
   *  assistant entries committed before it), the process that asked it, the latest partial it committed (as stable JSON,
   *  kept once seen even when a later snapshot shows the marker bare), and whether it has been counted as a cut ask. */
  live: Record<string, { open?: { at: number; process: number; partial?: string; counted?: boolean }; generation?: { attempt?: Json; message?: Json } }>;
  /** Per position (`<conv> <position>`), the cut asks counted: each ask a process died under, once, proven when it had
   *  committed a partial and possible when only its start marker. Re-asks at a position are its asks minus one. */
  reasks: Record<string, { proven: number; possible: number }>;
  askStarts: number;
  /** False once a `pi.live` line of a version this fold does not know is seen. */
  liveKnown: boolean;
  processes: number;
  kills: number;
  journalOpens: number;
  lastGen: number | undefined;
};

export type Counters = {
  paid: { total: number; workflow: number; agent: number };
  /** Repeated over what is measured: effects whose host reported calls, and paid agent calls. */
  repeated: number;
  /** Effects whose host reported no calls: their repeats are not measured (the strip says so, never 0). */
  repeatedNotMeasured: number;
  askedTwice: number;
  unknown: number;
  inFlight: number;
  judge: { answered: number; failed: number; reasked: number };
  /** committed: assistant entries that are not `aborted`. reasked: the extra asks (a position's asks minus one), from the
   *  asks a process died under, each counted once: proven when the cut ask had committed a partial, possible when only its
   *  start marker (the process may have died before it called the model); turns, the positions with at least one. Null
   *  (not measured) when no ask start was committed or the `pi.live` version is not one this fold knows. Only proven ones
   *  count. */
  modelTurns: { committed: number; reasked: { proven: { turns: number; reasks: number }; possible: { turns: number; reasks: number } } | null };
  processes: number;
  kills: number;
  journalOpens: number;
  cost: number | null;
  /** False when no durable line was folded: every count from the store is then not measured, and cost is unknown. */
  measured: boolean;
};


export const counterFold: Fold<CounterState> = {
  init: () => ({ effects: {}, receipts: {}, appliedIn: {}, listed: {}, effectsSeen: {}, reported: {}, paidKeys: {}, toolCalls: {}, executions: [], lostPaid: 0, lostAgent: 0, lostJudge: ZERO,
    highest: -1, inSnapshot: false, opened: false, decisions: {}, committedTurns: {}, modelCost: 0, modelCostKnown: true, modelPriced: false, measured: false, charges: {}, lostCharges: 0, live: {}, reasks: {}, askStarts: 0, liveKnown: true, processes: 0, kills: 0, journalOpens: 0, lastGen: undefined }),
  accepts: (line) => line.channel === 'durable' || line.source === 'host',
  reduce(state, line) {
    const next: CounterState = { ...state };
    if (line.channel === 'live') {
      if (line.kind === 'process.started') { next.processes = state.processes + 1; next.opened = true; }
      if (line.kind === 'kill') next.kills = state.kills + 1;
      return next;
    }
    next.measured = true;
    if (line.gen !== undefined) next.lastGen = line.gen;
    if (line.commit !== undefined) {
      const first = line.snapshot === true && (state.opened || !state.inSnapshot);
      next.inSnapshot = line.snapshot === true;
      if (line.snapshot === true) next.opened = false;
      else if (state.retained) next.retained = undefined;
      if (first && line.commit < state.highest) {
        // A restore: the state is the snapshot's from here, and what the lost branch completed was paid all the same.
        const restored = line.commit;
        next.lostPaid = state.lostPaid + Object.values(state.effects).filter((effect) => effect.completedAt !== undefined && effect.completedAt > restored).length;
        next.lostAgent = state.lostAgent + Object.values(state.receipts).reduce((sum, history) => sum + history.at(-1)![1] - (asOf(history, restored) ?? 0), 0);
        let lost = state.lostJudge;
        for (const history of Object.values(state.decisions)) {
          const latest = history.at(-1)![1];
          const then = asOf(history, restored) ?? ZERO;
          // Rows are appended, so what the latest holds beyond the checkpoint's is the lost branch's.
          lost = { answered: [...lost.answered, ...latest.answered.slice(then.answered.length)], failed: lost.failed + latest.failed - then.failed,
            cost: [...lost.cost, ...latest.cost.slice(then.cost.length)] };
        }
        next.lostJudge = lost;
        const upTo = <T>(histories: Record<string, History<T>>) => Object.fromEntries(Object.entries(histories).map(([key, history]) => [key, history.filter(([at]) => at <= restored)]).filter(([, history]) => history.length > 0));
        next.retained = {
          effects: Object.fromEntries(Object.entries(state.effects).flatMap(([id, effect]) => (effect.completedAt !== undefined && effect.completedAt <= restored ? [[id, effect.completedAt]] : []))),
          receipts: upTo(state.receipts), decisions: upTo(state.decisions), charges: upTo(state.charges),
        };
        // A charge is a running total: what the lost branch added beyond the checkpoint was spent all the same.
        let lostCharges = state.lostCharges;
        for (const history of Object.values(state.charges)) {
          const latest = history.at(-1)![1];
          const held = history.findLast(([at]) => at <= restored);
          const then = held ? held[1] : 0;
          lostCharges = lostCharges === null || latest === null || then === null ? null : lostCharges + Math.max(0, latest - then);
        }
        next.lostCharges = lostCharges;
        next.charges = {};
        next.effects = {};
        next.receipts = {};
        next.decisions = {};
        next.highest = line.commit;
      } else next.highest = Math.max(state.highest, line.commit);
    }
    const doc = docOf(line);
    if (doc) {
      const priced = [...(browserChargesOf(doc) ?? []).map((each) => [`browser ${docIdOf(line, doc)} ${each.tag}`, each.usd] as const),
        ...(lookChargesOf(doc) ?? []).map((each) => [`look ${docIdOf(line, doc)} ${each.receipt}`, each.usd] as const)];
      if (priced.length) {
        const charges = { ...next.charges };
        for (const [key, usd] of priced) charges[key] = [...(charges[key] ?? (line.snapshot === true ? next.retained?.charges[key] : undefined) ?? []), [line.commit!, usd]];
        next.charges = charges;
      }
      const opens = generationOf(doc);
      if (opens !== undefined) next.journalOpens = Math.max(state.journalOpens, opens);
      if (doc.doc === 'pi.live') {
        // Asks (section 6), from the store: pi commits `generation` without `message` before it calls the model, then its
        // partials. An ask a process died under, followed by another ask at its position, is a re-ask, counted once:
        // proven when it had committed a partial (on its own lines, or in the next snapshot), possible when only its start
        // marker. A snapshot can show the marker bare after pi drops the partial, so a snapshot never takes a partial back
        // and never classifies a cut ask alone. A later process's ask shows as its start marker line, a partial that differs
        // from the cut ask's, or its committed entry (a same-value marker writes no line). A snapshot still carrying a
        // generation is the ask already open, or a cut one whose start line died in flight, asked by the process before
        // the one opening; a bare marker unchanged across several opens stays one ask.
        if (doc.version !== undefined && doc.version !== PI_LIVE_VERSION) next.liveKnown = false;
        const conv = String(line.conv ?? '?');
        const held = next.live[conv] ?? {};
        const generation = liveGenerationOf(doc);
        const at = next.committedTurns[conv] ?? 0;
        let open = held.open;
        const partial = generation?.message !== undefined ? stableJson(generation.message) : undefined;
        const count = (ask: NonNullable<typeof open>) => {
          const key = `${conv} ${ask.at}`;
          const tally = next.reasks[key] ?? { proven: 0, possible: 0 };
          next.reasks = { ...next.reasks, [key]: ask.partial !== undefined ? { ...tally, proven: tally.proven + 1 } : { ...tally, possible: tally.possible + 1 } };
        };
        const cutBy = open !== undefined && open.at === at && open.process < next.processes && !open.counted ? open : undefined;
        if (line.snapshot === true) {
          if (generation === undefined) open = undefined;
          else if (open?.at === at) open = { ...open, ...(partial !== undefined ? { partial } : {}) };
          else { open = { at, process: next.processes - 1, ...(partial !== undefined ? { partial } : {}) }; next.askStarts += 1; }
        } else if (generation !== undefined && generation.message === undefined
          && (held.generation === undefined || held.generation.message !== undefined || held.generation.attempt !== generation.attempt)) {
          next.askStarts += 1;
          if (cutBy) count(cutBy);
          open = { at, process: next.processes };
        } else if (partial !== undefined) {
          if (open?.at === at && open.process === next.processes) open = { ...open, partial };
          else if (cutBy && cutBy.partial === partial) open = cutBy;
          else {
            if (cutBy) count(cutBy);
            open = { at, process: next.processes, partial };
            if (!cutBy) next.askStarts += 1;
          }
        }
        next.live = { ...next.live, [conv]: { ...(open ? { open } : {}), ...(generation ? { generation } : {}) } };
      }



      const effect = effectOf(doc);
      if (effect && doc.key !== undefined) {
        const id = docIdOf(line, doc);
        const before = next.effects[id];
        const gen = line.gen ?? 0;
        const completes = effect.status === 'completed' && before?.status !== 'completed';
        if (!next.effectsSeen[id]) next.effectsSeen = { ...next.effectsSeen, [id]: true };
        // Repeated and asked twice per effect (section 6): its calls list is append-only and every line carries the
        // whole list, so each line, a snapshot included, adds only the calls beyond the previous line's list, in the
        // line's generation (a snapshot's is the earlier process's: they were committed before the open, and their own
        // lines were lost in flight). A list that does not extend the previous one (a restore's snapshot,
        // or an admission's record with none) becomes the base, and what a lost branch added stays where it was seen.
        const shown = (callsOf(effect) ?? []).map(stableJson);
        if (shown.length > 0 && !next.reported[id]) next.reported = { ...next.reported, [id]: true };
        const base = next.listed[id] ?? [];
        const fresh = base.length <= shown.length && base.every((call, at) => shown[at] === call) ? shown.slice(base.length) : [];
        const count = fresh.filter((call) => applied(JSON.parse(call) as Json)).length;
        // A snapshot's gen is the driver's at its commit: the process before the one opening, where these were made.
        if (count > 0) next.appliedIn = { ...next.appliedIn, [id]: [...(next.appliedIn[id] ?? []), ...Array.from({ length: count }, () => gen)] };
        if (shown.length > 0 || base.length > 0) next.listed = { ...next.listed, [id]: shown };
        const completedAt = completes && line.snapshot !== true ? line.commit : before?.completedAt ?? (line.snapshot === true ? next.retained?.effects[id] : undefined);
        next.effects = { ...next.effects, [id]: { admitted: before ? before.admitted : line.snapshot === true ? undefined : line.gen, status: effect.status,
          ...(completedAt !== undefined ? { completedAt } : {}) } };
      }
      const receipts = receiptCountOf(doc);
      if (receipts !== undefined) {
        const at = docIdOf(line, doc);
        next.receipts = { ...next.receipts, [at]: [...(next.receipts[at] ?? (line.snapshot === true ? next.retained?.receipts[at] : undefined) ?? []), [line.commit!, receipts]] };
        if (doc.key !== undefined && !next.paidKeys[doc.key]) next.paidKeys = { ...next.paidKeys, [doc.key]: true };
      }
      const rows = decisionRowsOf(doc);
      if (rows) {
        const decisions: Record<string, Tally> = {};
        for (const row of rows) {
          const run = row.run_key ?? '';
          const tally = decisions[run] ?? (decisions[run] = { answered: [], failed: 0, cost: [] });
          if (row.error !== undefined) tally.failed += 1;
          else tally.answered.push(`${run} ${row.decision_id ?? ''}`);
          tally.cost.push(row.cost_usd ?? null);
        }
        const histories = { ...next.decisions };
        for (const [run, tally] of Object.entries(decisions)) histories[run] = [...(histories[run] ?? (line.snapshot === true ? next.retained?.decisions[run] : undefined) ?? []), [line.commit!, tally]];
        next.decisions = histories;
      }
    }
    const entry = entryOf(line);
    if (entry) {
      for (const message of entry.model) {
        if (message.role === 'assistant') {
          // A cut answer's partial is appended as an `aborted` entry when the next ask starts: not a committed turn, but
          // its usage still counts in cost.
          const conv = String(line.conv ?? '?');
          if (message.stopReason !== 'aborted') {
            // An ask a process died under, answered by a later process: that process's ask shows as this entry. Counted once.
            const held = next.live[conv];
            const at = next.committedTurns[conv] ?? 0;
            if (held?.open && held.open.at === at && held.open.process < next.processes && !held.open.counted) {
              const key = `${conv} ${at}`;
              const tally = next.reasks[key] ?? { proven: 0, possible: 0 };
              next.reasks = { ...next.reasks, [key]: held.open.partial !== undefined ? { ...tally, proven: tally.proven + 1 } : { ...tally, possible: tally.possible + 1 } };
            }
            next.committedTurns = { ...next.committedTurns, [conv]: at + 1 };
            if (held?.open !== undefined) next.live = { ...next.live, [conv]: { ...(held.generation ? { generation: held.generation } : {}) } };
          }
          const cost = costOf(message);
          next.modelPriced = true;
          if (cost === null) next.modelCostKnown = false; else next.modelCost = next.modelCost + cost;
          const calls = { ...next.toolCalls };
          for (const call of toolCallsOf(message)) calls[call.id] = receiptKeyOf(call.name, call.arguments);
          next.toolCalls = calls;
        }
        if (message.role === 'toolResult' && message.toolCallId && line.snapshot !== true) {
          // An executed call: not answered from a receipt (reused) and not refused as unknown. Whether it was paid is
          // whether the run holds a receipt under its key, known at the stop (countersOf).
          const status = message.details?.effect_status;
          const answered = message.details?.reused === true || message.details?.refused === true || status === 'reused' || status === 'refused';
          const key = next.toolCalls[message.toolCallId];
          if (key && !answered && !message.isError) next.executions = [...next.executions, { key, gen: line.gen ?? 0 }];
        }
      }
    }
    return next;
  },
};

/** The strip at a stop. `ended`: the stop is the recording's end, so no process is alive to finish an effect.
 */
export function countersOf(state: CounterState, ended: boolean): Counters {
  const effects = Object.values(state.effects);
  const workflow = effects.filter((effect) => effect.status === 'completed').length + state.lostPaid;
  const agent = Object.values(state.receipts).reduce((sum, history) => sum + history.at(-1)![1], 0) + state.lostAgent;
  // Repeated and asked twice (section 6): each applied call of an effect, or paid execution of one receipt key, after
  // the first is one extra payment, counted once: in repeated when its generation is later than the previous one's, in
  // asked twice when it is the same. A call with no receipt is not paid and counts nothing; an effect whose host reported
  // no calls is not measured.
  let repeated = 0;
  let askedTwice = 0;
  const extras = (gens: number[]) => gens.forEach((gen, index) => { if (index > 0) { if (gen === gens[index - 1]) askedTwice += 1; else repeated += 1; } });
  Object.values(state.appliedIn).forEach(extras);
  const byKey = new Map<string, number[]>();
  for (const { key, gen } of state.executions) if (state.paidKeys[key]) byKey.set(key, [...(byKey.get(key) ?? []), gen]);
  byKey.forEach(extras);
  const repeatedNotMeasured = Object.keys(state.effectsSeen).filter((id) => !state.reported[id]).length;
  const open = effects.filter((effect) => effect.status === 'unknown');
  const alive = (effect: (typeof effects)[number]) => !ended && effect.admitted !== undefined && effect.admitted === state.lastGen;
  // Judge asks: the rows the store holds and a lost branch's (3.2); re-asked is a second answered row of one decision.
  const tallies = [state.lostJudge, ...Object.values(state.decisions).map((history) => history.at(-1)![1])];
  const answered = tallies.flatMap((tally) => tally.answered);
  const judge = { answered: answered.length, failed: tallies.reduce((sum, tally) => sum + tally.failed, 0), reasked: answered.length - new Set(answered).size };
  // Cost is null until a durable line prices a part (section 6: null, never 0), and null when any part is unknown.
  const parts: (number | null)[] = [...(state.modelPriced ? [state.modelCostKnown ? state.modelCost : null] : []), ...tallies.flatMap((tally) => tally.cost),
    ...Object.values(state.charges).map((history) => history.at(-1)![1]), ...(state.lostCharges === 0 ? [] : [state.lostCharges])];
  const measured = state.liveKnown && state.askStarts > 0;
  const cutAsks = Object.values(state.reasks);
  const split = (kind: 'proven' | 'possible') => ({ turns: cutAsks.filter((tally) => tally[kind] > 0).length, reasks: cutAsks.reduce((sum, tally) => sum + tally[kind], 0) });
  return {
    paid: { total: workflow + agent, workflow, agent },
    repeated,
    repeatedNotMeasured,
    askedTwice,
    unknown: open.filter((effect) => !alive(effect)).length,
    inFlight: open.filter(alive).length,
    judge,
    modelTurns: { committed: Object.values(state.committedTurns).reduce((sum, count) => sum + count, 0), reasked: measured ? { proven: split('proven'), possible: split('possible') } : null },
    processes: state.processes,
    kills: state.kills,
    journalOpens: state.journalOpens,
    cost: parts.length === 0 || parts.some((part) => part === null) ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0),
    measured: state.measured,
  };
}

/** The strip's repeated: "not measured" when nothing measured repeats and an effect's host reported no calls, never 0. */
export const repeatedLabel = (counters: Counters): string => (counters.repeated === 0 && counters.repeatedNotMeasured > 0 ? 'not measured' : String(counters.repeated));
