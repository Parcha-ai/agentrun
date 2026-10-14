// The counters strip (RECORDING.md section 6), one fold for every recording. Counts come from durable lines, and
// processes and kills from the supervisor's host lines; a count only live lines can give is "observed".
import type { Json, Line } from './format.ts';
import type { Fold } from './replay.ts';
import {
  costOf, decisionRowsOf, docOf, effectIdOf, effectOf, entryOf, generationOf, receiptCountOf, stableJson, toolCallsOf,
  type Effect,
} from './durable.ts';

type Admission = { identity: string; gen: number | undefined; completed: boolean };
type Dispatch = { identity: string; gen: number | undefined; completedBefore: boolean };

export type CounterState = {
  effects: Record<string, { admitted: number | undefined; identity: string; status: Effect['status'] }>;
  receipts: Record<string, number>;
  dispatches: Dispatch[];
  toolCalls: Record<string, string>;
  decisions: Record<string, { answered: number; failed: number; reasked: number; cost: (number | null)[] }>;
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
  askedTwice: number;
  unknown: number;
  inFlight: number;
  judge: { answered: number; failed: number; reasked: number };
  turns: { committed: number; reaskedObserved: number };
  processes: number;
  kills: number;
  journalOpens: number;
  cost: number | null;
};

const identityOf = (effect: Effect) => (effect.intent ? `tool ${effect.intent.tool} ${effect.intent.argsHash}` : `name ${effect.name} ${effect.argsHash}`);

export const counterFold: Fold<CounterState> = {
  init: () => ({ effects: {}, receipts: {}, dispatches: [], toolCalls: {}, decisions: {}, committedTurns: {}, modelCost: 0, modelCostKnown: true,
    observedStarts: {}, processes: 0, kills: 0, journalOpens: 0, lastGen: undefined }),
  accepts: (line) => line.channel === 'durable' || line.source === 'host' || (line.source === 'pi' && line.kind === 'turn_start'),
  reduce(state, line) {
    const next: CounterState = { ...state };
    if (line.channel === 'live') {
      if (line.kind === 'process.started') next.processes = state.processes + 1;
      if (line.kind === 'kill') next.kills = state.kills + 1;
      if (line.kind === 'turn_start') {
        // A turn's start, per process: the same turn started in two processes was asked again (observed).
        const turn = typeof (line.data as { turn?: Json })?.turn === 'number' ? (line.data as { turn: number }).turn : -1;
        const id = `${line.conv ?? '?'} ${turn}`;
        next.observedStarts = { ...state.observedStarts, [id]: [...(state.observedStarts[id] ?? []), line.gen ?? 0] };
      }
      return next;
    }
    if (line.gen !== undefined) next.lastGen = line.gen;
    const doc = docOf(line);
    if (doc) {
      const opens = generationOf(doc);
      if (opens !== undefined) next.journalOpens = Math.max(state.journalOpens, opens);
      const effect = effectOf(doc);
      if (effect && doc.key !== undefined) {
        const id = effectIdOf(doc.key);
        const before = state.effects[id];
        const identity = identityOf(effect);
        if (!before && line.snapshot !== true) {
          // The first revision of an effect is its admission: one dispatch of its identity. A snapshot is state, not a dispatch.
          const completedBefore = Object.values(state.effects).some((other) => other.identity === identity && other.status === 'completed');
          next.dispatches = [...state.dispatches, { identity, gen: line.gen, completedBefore }];
        }
        next.effects = { ...state.effects, [id]: { admitted: before ? before.admitted : line.snapshot === true ? undefined : line.gen, identity, status: effect.status } };
      }
      const receipts = receiptCountOf(doc);
      if (receipts !== undefined) next.receipts = { ...state.receipts, [doc.key ?? '']: receipts };
      const rows = decisionRowsOf(doc);
      if (rows) {
        const decisions: CounterState['decisions'] = {};
        const answeredBy = new Map<string, number>();
        for (const row of rows) {
          const run = row.run_key ?? '';
          const tally = decisions[run] ?? (decisions[run] = { answered: 0, failed: 0, reasked: 0, cost: [] });
          if (row.error !== undefined) tally.failed += 1;
          else {
            tally.answered += 1;
            const id = `${run} ${row.decision_id ?? ''}`;
            const seen = answeredBy.get(id) ?? 0;
            if (seen > 0) tally.reasked += 1;
            answeredBy.set(id, seen + 1);
          }
          tally.cost.push(row.cost_usd ?? null);
        }
        next.decisions = { ...state.decisions, ...decisions };
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
          for (const call of toolCallsOf(message)) calls[call.id] = `call ${call.name} ${stableJson(call.arguments)}`;
          next.toolCalls = calls;
        }
        if (message.role === 'toolResult' && message.toolCallId) {
          const reused = message.details?.reused === true || message.details?.refused === true;
          const identity = next.toolCalls[message.toolCallId];
          if (identity && !reused && !message.isError) {
            const completedBefore = next.dispatches.some((other) => other.identity === identity);
            next.dispatches = [...next.dispatches, { identity, gen: line.gen, completedBefore }];
          }
        }
      }
    }
    return next;
  },
};

/** The strip at a stop. `ended`: the stop is the recording's end, so no process is alive to finish an effect. */
export function countersOf(state: CounterState, ended: boolean): Counters {
  const effects = Object.values(state.effects);
  const workflow = effects.filter((effect) => effect.status === 'completed').length;
  const agent = Object.values(state.receipts).reduce((sum, count) => sum + count, 0);
  let repeated = 0;
  let askedTwice = 0;
  state.dispatches.forEach((dispatch, index) => {
    const earlier = state.dispatches.slice(0, index).filter((other) => other.identity === dispatch.identity);
    if (earlier.length === 0) return;
    if (earlier.some((other) => other.gen === dispatch.gen)) askedTwice += 1;
    else if (dispatch.completedBefore && earlier.some((other) => (other.gen ?? 0) < (dispatch.gen ?? 0))) repeated += 1;
  });
  const open = effects.filter((effect) => effect.status === 'unknown');
  const alive = (effect: (typeof effects)[number]) => !ended && effect.admitted !== undefined && effect.admitted === state.lastGen;
  const judge = { answered: 0, failed: 0, reasked: 0 };
  const parts: (number | null)[] = [state.modelCostKnown ? state.modelCost : null];
  for (const tally of Object.values(state.decisions)) {
    judge.answered += tally.answered; judge.failed += tally.failed; judge.reasked += tally.reasked;
    parts.push(...tally.cost);
  }
  const reaskedObserved = Object.values(state.observedStarts).reduce((sum, gens) => sum + Math.max(0, new Set(gens).size - 1), 0);
  return {
    paid: { total: workflow + agent, workflow, agent },
    repeated,
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
