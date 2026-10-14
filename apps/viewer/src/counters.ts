// The counters strip (RECORDING.md section 6), one fold for every recording. Counts come from durable lines, and
// processes and kills from the supervisor's host lines; a count only live lines can give is "observed".
import type { Json, Line } from './format.ts';
import type { Fold } from './replay.ts';
import {
  callsOf, costOf, decisionRowsOf, docOf, effectIdOf, effectOf, entryOf, generationOf, receiptCountOf, stableJson, toolCallsOf,
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

export type CounterState = {
  effects: Record<string, { admitted: number | undefined; status: Effect['status']; completedAt?: number }>;
  receipts: Record<string, History<number>>;
  /** Per effect id, the generation of each of its own applied outside calls, a lost branch included: never reset. */
  callGens: Record<string, number[]>;
  /** Per effect id, the `calls` it last showed (each record as stable JSON) and in which generation, a snapshot's
   *  included: the driver replaces the list in each process, so only what differs from it is a new call. */
  lastCalls: Record<string, { gen: number; snapshot: boolean; calls: string[]; kept: boolean }>;
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
  snapshotted: number[];
  decisions: Record<string, History<Tally>>;
  committedTurns: Record<string, number>;
  modelCost: number;
  modelCostKnown: boolean;
  observedStarts: Record<string, number[]>;
  processes: number;
  kills: number;
  journalOpens: number;
  lastGen: number | undefined;
};

export type Counters = {
  paid: { total: number; workflow: number; agent: number };
  repeated: number;
  /** Workflow effects whose host reports no calls: their repeats are not measured, so a repeated of 0 is not shown as 0 while any exist. */
  repeatedNotMeasured: number;
  askedTwice: number;
  unknown: number;
  inFlight: number;
  judge: { answered: number; failed: number; reasked: number };
  /** reaskedObserved is null when the recording has no live turn starts: not observed is not zero. */
  turns: { committed: number; reaskedObserved: number | null };
  processes: number;
  kills: number;
  journalOpens: number;
  cost: number | null;
};

/** An outside call that was applied (RECORDING.md section 5): a record whose `outcome` is `applied`. `failed` and `unknown` are not. */
/** Whether a live `message_start` line is the start of an assistant message (pi's event: `{ message: { role } }`). */
const assistantStart = (line: Line): boolean => {
  const data = line.data as { message?: { role?: Json }; role?: Json } | null;
  return (data?.message?.role ?? data?.role) === 'assistant';
};

const callApplied = (record: Json): boolean => typeof record === 'object' && record !== null && !Array.isArray(record) && record.outcome === 'applied';

export const counterFold: Fold<CounterState> = {
  init: () => ({ effects: {}, receipts: {}, callGens: {}, lastCalls: {}, paidKeys: {}, toolCalls: {}, executions: [], lostPaid: 0, lostAgent: 0, lostJudge: ZERO,
    highest: -1, snapshotted: [], decisions: {}, committedTurns: {}, modelCost: 0, modelCostKnown: true, observedStarts: {}, processes: 0, kills: 0, journalOpens: 0, lastGen: undefined }),
  accepts: (line) => line.channel === 'durable' || line.source === 'host' || (line.source === 'pi' && (line.kind === 'turn_start' || line.kind === 'message_start')),
  reduce(state, line) {
    const next: CounterState = { ...state };
    if (line.channel === 'live') {
      if (line.kind === 'process.started') next.processes = state.processes + 1;
      if (line.kind === 'kill') next.kills = state.kills + 1;
      if (line.source === 'pi' && line.kind === 'message_start' && assistantStart(line)) {
        // An ask's position is (conversation, the assistant entries already committed in it): more than one ask at one position, in
        // different processes, is re-asked (observed, never proven). A resumed process emits no turn_start, so this is the measure.
        const id = `${line.conv ?? '?'} ${state.committedTurns[String(line.conv ?? '?')] ?? 0}`;
        next.observedStarts = { ...state.observedStarts, [id]: [...(state.observedStarts[id] ?? []), line.gen ?? 0] };
      }
      if (line.kind === 'turn_start') {
        // A turn's start, per process: the same turn started in two processes was asked again (observed).
        const turn = typeof (line.data as { turn?: Json })?.turn === 'number' ? (line.data as { turn: number }).turn : -1;
        const id = `${line.conv ?? '?'} ${turn}`;
        next.observedStarts = { ...state.observedStarts, [id]: [...(state.observedStarts[id] ?? []), line.gen ?? 0] };
      }
      return next;
    }
    if (line.gen !== undefined) next.lastGen = line.gen;
    if (line.commit !== undefined) {
      const first = line.snapshot === true && !state.snapshotted.includes(line.gen ?? 0);
      if (first) next.snapshotted = [...state.snapshotted, line.gen ?? 0];
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
      const effect = effectOf(doc);
      if (effect && doc.key !== undefined) {
        const id = effectIdOf(doc.key);
        const before = next.effects[id];
        const gen = line.gen ?? 0;
        const completes = effect.status === 'completed' && before?.status !== 'completed';
        // Repeated is per call (section 6). An effect's calls are append-only and every line carries the whole list, so each line,
        // snapshots included, contributes only the calls beyond the previous line's list. A non-snapshot line gives them its own
        // generation; a snapshot gives them an earlier one (they were committed before its process opened, and their own lines were
        // lost in flight). A list that does not extend the previous one (a restore's snapshot, or a revision with no calls yet) is the
        // new base, and the calls counted so far stay where they were first seen. An effect whose host reports no calls has repeated
        // not measured: its completion is not a call.
        const shown = (callsOf(effect) ?? []).map(stableJson);
        const last = next.lastCalls[id];
        const base = last?.calls ?? [];
        const extends_ = base.every((call, index) => shown[index] === call);
        const fresh = extends_ ? shown.slice(base.length) : [];
        const callGen = line.snapshot === true ? gen - 1 : gen;
        const applied = fresh.filter((call) => callApplied(JSON.parse(call) as Json)).length;
        if (applied > 0) next.callGens = { ...next.callGens, [id]: [...(next.callGens[id] ?? []), ...Array.from({ length: applied }, () => callGen)] };
        next.lastCalls = { ...next.lastCalls, [id]: { gen, snapshot: line.snapshot === true, calls: shown, kept: (last?.kept ?? false) || callsOf(effect) !== undefined } };
        const completedAt = completes && line.snapshot !== true ? line.commit : before?.completedAt;
        next.effects = { ...next.effects, [id]: { admitted: before ? before.admitted : line.snapshot === true ? undefined : line.gen, status: effect.status,
          ...(completedAt !== undefined ? { completedAt } : {}) } };
      }
      const receipts = receiptCountOf(doc);
      if (receipts !== undefined) {
        next.receipts = { ...next.receipts, [doc.key ?? '']: [...(next.receipts[doc.key ?? ''] ?? []), [line.commit!, receipts]] };
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
          const conv = String(line.conv ?? '?');
          next.committedTurns = { ...next.committedTurns, [conv]: (next.committedTurns[conv] ?? 0) + 1 };
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

/** Whether a recording carries the live lines re-asked turns are observed from. */
export const observesTurns = (lines: Line[]) => lines.some((line) => line.channel === 'live' && line.source === 'pi' && (line.kind === 'turn_start' || (line.kind === 'message_start' && assistantStart(line))));

/** The strip at a stop. `ended`: the stop is the recording's end, so no process is alive to finish an effect.
 *  `turnStarts`: the recording has live turn starts (`observesTurns`), so re-asked turns are observed, not unknown. */
export function countersOf(state: CounterState, ended: boolean, turnStarts = true): Counters {
  const effects = Object.values(state.effects);
  const workflow = effects.filter((effect) => effect.status === 'completed').length + state.lostPaid;
  const agent = Object.values(state.receipts).reduce((sum, history) => sum + history.at(-1)![1], 0) + state.lostAgent;
  // Repeated and asked twice, per call (section 6). An effect: each later generation its own calls completed in. An
  // agent's paid call (the run holds its receipt key): each later generation that executed it is repeated, and each
  // further execution within one generation is asked twice. A call with no receipt is not paid and counts nothing.
  let repeated = 0;
  let askedTwice = 0;
  for (const gens of Object.values(state.callGens)) {
    const perGen = new Map<number, number>();
    for (const gen of gens) perGen.set(gen, (perGen.get(gen) ?? 0) + 1);
    repeated += perGen.size - 1;
    for (const count of perGen.values()) askedTwice += count - 1;
  }
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
  const reaskedObserved = turnStarts ? Object.values(state.observedStarts).reduce((sum, gens) => sum + Math.max(0, new Set(gens).size - 1), 0) : null;
  return {
    paid: { total: workflow + agent, workflow, agent },
    repeated,
    repeatedNotMeasured: Object.keys(state.effects).filter((id) => !state.lastCalls[id]?.kept).length,
    askedTwice,
    unknown: open.filter((effect) => !alive(effect)).length,
    inFlight: open.filter(alive).length,
    judge,
    turns: { committed: Object.values(state.committedTurns).reduce((sum, count) => sum + count, 0), reaskedObserved },
    processes: state.processes,
    kills: state.kills,
    journalOpens: state.journalOpens,
    cost: parts.some((part) => part === null) ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0),
  };
}

/** What the strip shows for repeated: the count, or that it is not measured when it is 0 and some workflow effect reports no calls. */
export const repeatedLabel = (counters: Counters): string => (counters.repeated === 0 && counters.repeatedNotMeasured > 0 ? 'not measured' : String(counters.repeated));
