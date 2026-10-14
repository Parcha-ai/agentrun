// The counters strip (RECORDING.md section 6), one fold for every recording. Counts come from durable lines, and
// processes and kills from the supervisor's host lines; a count only live lines can give is "observed".
import type { Json, Line } from './format.ts';
import type { Fold } from './replay.ts';
import {
  applied, callsOf, costOf, decisionRowsOf, docIdOf, docOf, effectOf, entryOf, generationOf, liveGenerationOf, receiptCountOf, stableJson, toolCallsOf,
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
  /** Per effect, its `applied` outside calls by the generation each is placed in, a lost branch included: never reset. */
  appliedIn: Record<string, Record<string, number>>;
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
  /** Whether the last durable line was a snapshot: an open's snapshot is a run of them. */
  inSnapshot: boolean;
  decisions: Record<string, History<Tally>>;
  committedTurns: Record<string, number>;
  modelCost: number;
  modelCostKnown: boolean;
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
  /** committed: assistant entries that are not `aborted`. Re-asks are counted per position as its asks minus one, from the asks a
   *  process died under, each counted once: reasked, those that had committed a partial (proven; reaskedTurns, the positions
   *  with at least one); reaskedPossible, those with only the start marker committed (the process may have died before it called
   *  the model). All null (not measured) when no ask start was committed or the `pi.live` version is not one this fold knows.
   *  Only proven ones count. */
  turns: { committed: number; reasked: number | null; reaskedTurns: number | null; reaskedPossible: number | null };
  processes: number;
  kills: number;
  journalOpens: number;
  cost: number | null;
};


export const counterFold: Fold<CounterState> = {
  init: () => ({ effects: {}, receipts: {}, appliedIn: {}, listed: {}, effectsSeen: {}, reported: {}, paidKeys: {}, toolCalls: {}, executions: [], lostPaid: 0, lostAgent: 0, lostJudge: ZERO,
    highest: -1, inSnapshot: false, decisions: {}, committedTurns: {}, modelCost: 0, modelCostKnown: true, live: {}, reasks: {}, askStarts: 0, liveKnown: true, processes: 0, kills: 0, journalOpens: 0, lastGen: undefined }),
  accepts: (line) => line.channel === 'durable' || line.source === 'host',
  reduce(state, line) {
    const next: CounterState = { ...state };
    if (line.channel === 'live') {
      if (line.kind === 'process.started') next.processes = state.processes + 1;
      if (line.kind === 'kill') next.kills = state.kills + 1;
      return next;
    }
    if (line.gen !== undefined) next.lastGen = line.gen;
    if (line.commit !== undefined) {
      const first = line.snapshot === true && !state.inSnapshot;
      next.inSnapshot = line.snapshot === true;
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
        next.effects = {};
        next.receipts = {};
        next.decisions = {};
        next.highest = line.commit;
      } else next.highest = Math.max(state.highest, line.commit);
    }
    const doc = docOf(line);
    if (doc) {
      const opens = generationOf(doc);
      if (opens !== undefined) next.journalOpens = Math.max(state.journalOpens, opens);
      if (doc.doc === 'pi.live') {
        // Asks (section 6), from the store: pi commits `generation` without `message` before it calls the model, then its
        // partials. An ask open when its process died, followed by another ask at its position, is re-asked: proven when
        // it had committed a partial, possible when only its start marker. A later process's ask at a position whose
        // marker is still there writes no line of its own (the value is the same), so it shows as its first partial or
        // its committed entry. A snapshot still carrying a generation is the ask already open, or a cut one whose start
        // line died in flight, asked by the process before the one opening.
        if (doc.version !== undefined && doc.version !== PI_LIVE_VERSION) next.liveKnown = false;
        const conv = String(line.conv ?? '?');
        const held = next.live[conv] ?? {};
        const generation = liveGenerationOf(doc);
        const at = next.committedTurns[conv] ?? 0;
        let open = held.open;
        const partial = generation?.message !== undefined ? stableJson(generation.message) : undefined;
        // A process died under an ask: count it once, proven when it had committed a partial, else possible.
        const count = (ask: NonNullable<typeof open>) => {
          const key = `${conv} ${ask.at}`;
          const tally = next.reasks[key] ?? { proven: 0, possible: 0 };
          next.reasks = { ...next.reasks, [key]: ask.partial !== undefined ? { ...tally, proven: tally.proven + 1 } : { ...tally, possible: tally.possible + 1 } };
          return { ...ask, counted: true };
        };
        const cutBy = open !== undefined && open.at === at && open.process < next.processes && !open.counted ? open : undefined;
        if (line.snapshot === true) {
          if (generation === undefined) open = undefined;
          else if (open?.at === at) open = { ...open, ...(partial !== undefined ? { partial } : {}) };
          else { open = { at, process: next.processes - 1, ...(partial !== undefined ? { partial } : {}) }; next.askStarts += 1; }
        } else if (generation !== undefined && generation.message === undefined
          && (held.generation === undefined || held.generation.message !== undefined || held.generation.attempt !== generation.attempt)) {
          // A start marker line: the ask begins. One a process died under is counted now.
          next.askStarts += 1;
          if (cutBy) count(cutBy);
          open = { at, process: next.processes };
        } else if (partial !== undefined) {
          if (open?.at === at && open.process === next.processes) open = { ...open, partial };
          else if (cutBy && cutBy.partial === partial) open = cutBy;
          else {
            // A later process's own partial, or one that differs from the cut ask's: that process asked again and the model answered.
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
        if (count > 0) {
          // A snapshot's gen is the driver's at its commit: the process before the one opening, where these were made.
          const placed = gen;
          const byGen = next.appliedIn[id] ?? {};
          next.appliedIn = { ...next.appliedIn, [id]: { ...byGen, [placed]: (byGen[placed] ?? 0) + count } };
        }
        if (shown.length > 0 || base.length > 0) next.listed = { ...next.listed, [id]: shown };
        const completedAt = completes && line.snapshot !== true ? line.commit : before?.completedAt;
        next.effects = { ...next.effects, [id]: { admitted: before ? before.admitted : line.snapshot === true ? undefined : line.gen, status: effect.status,
          ...(completedAt !== undefined ? { completedAt } : {}) } };
      }
      const receipts = receiptCountOf(doc);
      if (receipts !== undefined) {
        const at = docIdOf(line, doc);
        next.receipts = { ...next.receipts, [at]: [...(next.receipts[at] ?? []), [line.commit!, receipts]] };
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
        for (const [run, tally] of Object.entries(decisions)) histories[run] = [...(histories[run] ?? []), [line.commit!, tally]];
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
  // Repeated and asked twice, per call (section 6). An effect's applied calls, or an agent's paid executions of one
  // receipt key (a call with no receipt is not paid and counts nothing): each later generation that has one is
  // repeated, and each further one within a generation is asked twice. An effect whose host reported no calls is not
  // measured.
  let repeated = 0;
  let askedTwice = 0;
  for (const byGen of Object.values(state.appliedIn)) {
    repeated += Object.keys(byGen).length - 1;
    for (const count of Object.values(byGen)) askedTwice += count - 1;
  }
  const repeatedNotMeasured = Object.keys(state.effectsSeen).filter((id) => !state.reported[id]).length;
  const byKey = new Map<string, Map<number, number>>();
  for (const { key, gen } of state.executions) {
    if (!state.paidKeys[key]) continue;
    const gens = byKey.get(key) ?? byKey.set(key, new Map()).get(key)!;
    gens.set(gen, (gens.get(gen) ?? 0) + 1);
  }
  for (const gens of byKey.values()) {
    repeated += gens.size - 1;
    for (const count of gens.values()) askedTwice += count - 1;
  }
  const open = effects.filter((effect) => effect.status === 'unknown');
  const alive = (effect: (typeof effects)[number]) => !ended && effect.admitted !== undefined && effect.admitted === state.lastGen;
  // Judge asks: the rows the store holds and a lost branch's (3.2); re-asked is a second answered row of one decision.
  const tallies = [state.lostJudge, ...Object.values(state.decisions).map((history) => history.at(-1)![1])];
  const answered = tallies.flatMap((tally) => tally.answered);
  const judge = { answered: answered.length, failed: tallies.reduce((sum, tally) => sum + tally.failed, 0), reasked: answered.length - new Set(answered).size };
  const parts: (number | null)[] = [state.modelCostKnown ? state.modelCost : null, ...tallies.flatMap((tally) => tally.cost)];
  const measured = state.liveKnown && state.askStarts > 0;
  const cutAsks = Object.values(state.reasks);
  const reasked = measured ? cutAsks.reduce((sum, tally) => sum + tally.proven, 0) : null;
  const reaskedTurns = measured ? cutAsks.filter((tally) => tally.proven > 0).length : null;
  const reaskedPossible = measured ? cutAsks.reduce((sum, tally) => sum + tally.possible, 0) : null;
  return {
    paid: { total: workflow + agent, workflow, agent },
    repeated,
    repeatedNotMeasured,
    askedTwice,
    unknown: open.filter((effect) => !alive(effect)).length,
    inFlight: open.filter(alive).length,
    judge,
    turns: { committed: Object.values(state.committedTurns).reduce((sum, count) => sum + count, 0), reasked, reaskedTurns, reaskedPossible },
    processes: state.processes,
    kills: state.kills,
    journalOpens: state.journalOpens,
    cost: parts.some((part) => part === null) ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0),
  };
}

/** The strip's repeated: "not measured" when nothing measured repeats and an effect's host reported no calls, never 0. */
export const repeatedLabel = (counters: Counters): string => (counters.repeated === 0 && counters.repeatedNotMeasured > 0 ? 'not measured' : String(counters.repeated));
