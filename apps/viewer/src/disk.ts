// The disk panel: where the run lives when it lives on a disk place (a claimed directory), and what happened to the claim.
// A timeline of incarnations (one per claim generation) with the kill, the fence and the takeover between them, the
// sealed sequence of a clean release, and every paid call marked made once, repeated or cut.
//
// What it reads (RECORDING.md section 5, host):
//   host, live, written by the supervisor outside the run's processes (no event-level `gen`; the process or incarnation a
//   line is about is in `data`):
//     `run.json`   the package's RunRecord, verbatim: { run, status, generation, sealedSeq, wakeAt, holder, heartbeatAt,
//                  updatedAt, detail }. A generation that goes up with a new holder is a claim; a non-null `sealedSeq`, or a
//                  status of paused, sleeping, done or failed, is a release. A line is written when status, generation,
//                  holder or sealedSeq changes (a poll, so a short-lived generation can be missed).
//     `delegation` the Archil delegation of the run's own path: { gen?, clientId, inodeId, isOrphaned, isPending, path? }; a client or inode id is a number or a label (a non-empty string).
//                  The first line with `isOrphaned` marks the first poll that SAW the orphan, not the instant it happened.
//     `revoke`     { gen?, revoked: [{ clientId, inodeId, path, isOrphaned }], ms }; `ms` is the whole takeover (the
//                  revoke plus the start of the next holder), never the revoke alone.
//     `fenced`     { gen, code, message, exit }: the old holder's first refused write (its FencedError's `code`, exit 75).
//                  Only a holder that is still alive writes one (a stall or a partition); a killed process or box never does.
//     `process.started` and `kill`, the shell's own (`kill.kind` is `box` or `process`, never inferred).
//   durable: `agentrun.effects` documents, for the paid calls (the shell's counter fold decides made once, repeated and cut).
// Pure: `accepts`, `reduce` and `view` read only their arguments. Kinds and fields it does not know are skipped; a `run.json`
// line without a run and an integer generation is refused, never misread.
import { counterFold, type CounterState } from './counters.ts';
import { applied, callsOf, docIdOf, docOf, effectIdOf, effectOf } from './durable.ts';
import { isSupervisor, under, type Json, type Line } from './format.ts';
import { h, register, type Node, type Panel, type ViewContext } from './panels.ts';

type DiskObj = { [key: string]: Json };
const diskObj = (value: Json | undefined): DiskObj | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined);
const diskStr = (value: Json | undefined): string | undefined => (typeof value === 'string' ? value : undefined);
const diskNum = (value: Json | undefined): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const diskList = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : []);

const DISK_KINDS = new Set(['run.json', 'delegation', 'revoke', 'fenced']);
const RELEASED = new Set(['paused', 'sleeping', 'done', 'failed']);

export type DiskHolder = { driver: string; host: string; pid: number | undefined; since: string | undefined };
export type DiskEnd = { how: 'released' | 'fenced' | 'killed' | 'replaced'; t: number; detail: string; box: boolean };
/** One claim of the run: the package's `generation`, who held it, from when, and how it ended. */
export type DiskIncarnation = { gen: number; holder: DiskHolder | undefined; from: number; end?: DiskEnd; sealedSeq?: number };
export type DiskEvent = { t: number; what: 'start' | 'claim' | 'seal' | 'status' | 'orphan' | 'revoke' | 'fence' | 'kill' | 'result'; gen?: number; text: string };
export type DiskState = {
  seen: boolean;
  /** The latest run.json: its status, generation and sealed sequence. */
  record: { status: string; generation: number; sealedSeq: number | null; wakeAt: string | null } | undefined;
  incarnations: DiskIncarnation[];
  events: DiskEvent[];
  /** Delegations seen, by `clientId:inodeId`: the poll time of the first line and whether any line said orphaned. */
  delegations: Record<string, { t: number; orphaned: boolean }>;
  /** The effect's label and workflow path, by the shell's document identity (the key the counter fold uses). */
  effects: Record<string, { label: string; path?: string }>;
  /** Calls settled from an answer an earlier process kept in evidence (`via: "evidence"`): the generation that recorded the settlement, by effect. The payment was made by the generation that admitted the effect. */
  settled: Record<string, number>;
  /** Each process the supervisor started and the claim generation it came to hold (run.json carries no process; the claim a process holds is the next one polled after it started). */
  owners: { process: number; claim?: number }[];
  /** The durable generations each claim wrote under (the non-snapshot durable lines seen while it was the newest claim; a poll that lags can credit a generation to the claim before). */
  durable: Record<number, number[]>;
  /** The durable generations of a claim whose holder a kill or a fence ended: their unfinished calls are cut, whatever the next line says, and a later generation's are not. */
  cuts: number[];
  ended: boolean;
  lastT: number;
  counters: CounterState;
};

const diskKnown = (line: Line): boolean => isSupervisor(line) && (DISK_KINDS.has(line.kind) || line.kind === 'process.started' || line.kind === 'kill' || line.kind === 'result');
const diskInit = (): DiskState => ({ seen: false, record: undefined, incarnations: [], events: [], delegations: {}, effects: {}, settled: {}, owners: [], durable: {}, cuts: [], ended: false, lastT: 0, counters: counterFold.init() });

const diskTime = (t: number) => `${(t / 1000).toFixed(1)} s`;
const diskHolderOf = (value: Json | undefined): DiskHolder | undefined => {
  const holder = diskObj(value);
  const host = diskStr(holder?.host);
  return holder && host !== undefined ? { driver: diskStr(holder.driver) ?? '?', host, pid: diskNum(holder.pid), since: diskStr(holder.since) } : undefined;
};
const diskHolderText = (holder: DiskHolder | undefined) => (holder ? `${holder.driver} ${holder.host}${holder.pid !== undefined ? ` pid ${holder.pid}` : ''}` : 'a holder not named');

/** Close the incarnation of `gen` (the newest with that number) unless it already ended. */
const diskEnd = (incarnations: DiskIncarnation[], gen: number, end: DiskEnd, sealedSeq?: number): DiskIncarnation[] => {
  const at = incarnations.map((each) => each.gen).lastIndexOf(gen);
  // An ending a poll inferred (`replaced`) gives way to a fact a later line states (a fence, a kill).
  if (at < 0 || (incarnations[at]!.end !== undefined && !(incarnations[at]!.end!.how === 'replaced' && end.how !== 'replaced'))) return incarnations;
  return incarnations.map((each, index) => (index === at ? { ...each, end, ...(sealedSeq !== undefined ? { sealedSeq } : {}) } : each));
};

function diskReduce(state: DiskState, line: Line): DiskState {
  let next: DiskState = { ...state, lastT: Math.max(state.lastT, line.t) };
  if (counterFold.accepts(line)) next = { ...next, counters: counterFold.reduce(state.counters, line) };
  const newest = next.incarnations.at(-1);
  if (newest !== undefined && line.channel === 'durable' && line.snapshot !== true && line.gen !== undefined && !(next.durable[newest.gen] ?? []).includes(line.gen)) {
    next = { ...next, durable: { ...next.durable, [newest.gen]: [...(next.durable[newest.gen] ?? []), line.gen] } };
  }
  const doc = docOf(line);
  const effect = doc ? effectOf(doc) : undefined;
  if (doc && effect && doc.key !== undefined) {
    const id = docIdOf(line, doc);
    if (next.effects[id] === undefined) next = { ...next, effects: { ...next.effects, [id]: { label: `${effect.name} ${effectIdOf(doc.key)}`, ...(line.path ? { path: line.path } : {}) } } };
    // A snapshot's generation is the earlier process's, so only a line a process wrote itself says who settled it.
    const settledByEvidence = (callsOf(effect) ?? []).some((call) => applied(call) && typeof call === 'object' && call !== null && !Array.isArray(call) && call.via === 'evidence');
    if (settledByEvidence && line.snapshot !== true && line.gen !== undefined && next.settled[id] === undefined) next = { ...next, settled: { ...next.settled, [id]: line.gen } };
    return next;
  }
  if (!isSupervisor(line)) return next;
  const data = diskObj(line.data);
  const add = (event: DiskEvent): DiskState => ({ ...next, events: [...next.events, event] });
  switch (line.kind) {
    case 'process.started': {
      const gen = diskNum(data?.gen);
      return gen === undefined ? next : { ...add({ t: line.t, what: 'start', gen, text: `process ${gen} started` }), owners: [...next.owners, { process: gen }] };
    }
    case 'kill': {
      const gen = diskNum(data?.gen);
      if (gen === undefined) return next;
      const box = data?.kind === 'box';
      const label = diskStr(data?.label) ?? 'no label';
      const grown = add({ t: line.t, what: 'kill', gen, text: `${box ? 'the box of process' : 'process'} ${gen} ${box ? 'taken away' : 'killed'}: ${label}` });
      // The kill names a process; the claim it held is the one polled after it started.
      const claim = grown.owners.find((owner) => owner.process === gen)?.claim;
      return { ...grown, cuts: claim === undefined ? grown.cuts : [...grown.cuts, ...(grown.durable[claim] ?? [])],
        incarnations: claim === undefined ? grown.incarnations : diskEnd(grown.incarnations, claim, { how: 'killed', t: line.t, detail: label, box }) };
    }
    case 'result':
      return { ...add({ t: line.t, what: 'result', text: 'the result was delivered' }), ended: true };
    case 'run.json': {
      const generation = diskNum(data?.generation);
      const run = diskStr(data?.run);
      const status = diskStr(data?.status);
      if (data === undefined || generation === undefined || !Number.isInteger(generation) || run === undefined || status === undefined) return next;
      const sealedSeq = diskNum(data.sealedSeq) ?? null;
      const record = { status, generation, sealedSeq, wakeAt: diskStr(data.wakeAt) ?? null };
      let grown: DiskState = { ...next, seen: true, record };
      const holder = diskHolderOf(data.holder);
      const latest = grown.incarnations.at(-1);
      if (latest === undefined || generation > latest.gen) {
        // A claim: the previous holder, if no kill or fence line ended it, was replaced between two polls.
        const replaced = latest && latest.end === undefined ? diskEnd(grown.incarnations, latest.gen, { how: 'replaced', t: line.t, detail: 'a new generation claimed the run', box: false }) : grown.incarnations;
        const free = grown.owners.map((owner) => owner.claim).lastIndexOf(undefined);
        grown = { ...grown, owners: grown.owners.map((owner, index) => (index === free ? { ...owner, claim: generation } : owner)), incarnations: [...replaced, { gen: generation, holder, from: line.t }], events: [...grown.events, { t: line.t, what: 'claim', gen: generation, text: `generation ${generation} claims the run: ${diskHolderText(holder)}` }] };
      } else if (generation === latest.gen) {
        grown = { ...grown, incarnations: grown.incarnations.map((each, index) => (index === grown.incarnations.length - 1 ? { ...each, holder: holder ?? each.holder } : each)) };
      }
      const newest = grown.incarnations.at(-1);
      if (generation === newest?.gen && RELEASED.has(status)) {
        // A release is the status. A running record may still carry the previous release's seal (the package clears it once the store is open), so a seal alone proves nothing.
        if (newest.end === undefined) {
          grown = { ...grown, incarnations: diskEnd(grown.incarnations, generation, { how: 'released', t: line.t, detail: status, box: false }, sealedSeq ?? undefined),
            events: [...grown.events, { t: line.t, what: 'seal', gen: generation, text: `generation ${generation} released the run (${status})${sealedSeq !== null ? `, sealed at sequence ${sealedSeq}` : ', no sealed sequence'}` }] };
        } else if (newest.end.how === 'released' && newest.sealedSeq === undefined && sealedSeq !== null) {
          // The package writes the status first and the seal after: the later record carries it.
          grown = { ...grown, incarnations: grown.incarnations.map((each, index) => (index === grown.incarnations.length - 1 ? { ...each, sealedSeq } : each)),
            events: [...grown.events, { t: line.t, what: 'seal', gen: generation, text: `generation ${generation}'s release was sealed at sequence ${sealedSeq}` }] };
        }
      } else if (state.record?.status !== status && state.record !== undefined) {
        grown = { ...grown, events: [...grown.events, { t: line.t, what: 'status', gen: generation, text: `run.json says ${status}` }] };
      }
      return grown;
    }
    case 'delegation': {
      const client = diskStr(data?.clientId) ?? (diskNum(data?.clientId) !== undefined ? String(diskNum(data?.clientId)) : undefined);
      // An inode id is a number or a label the recorder wrote for it (`inode-1`), any non-empty string: read as it comes, never pattern-matched. A claim is told apart by the text of its client and inode, so the same inode as a number
      // and as a label are two claims here: the reader cannot link 7001 to `inode-1`, and does not pretend to (a recording uses one scheme).
      const inode = diskNum(data?.inodeId) !== undefined ? String(diskNum(data?.inodeId)) : (diskStr(data?.inodeId) || undefined);
      if (client === undefined || inode === undefined) return next;
      const key = `${client}:${inode}`;
      const before = next.delegations[key];
      const orphaned = data?.isOrphaned === true;
      const grown: DiskState = { ...next, seen: true, delegations: { ...next.delegations, [key]: { t: before?.t ?? line.t, orphaned: orphaned || before?.orphaned === true } } };
      return orphaned && !before?.orphaned ? { ...grown, events: [...grown.events, { t: line.t, what: 'orphan', ...(diskNum(data?.gen) !== undefined ? { gen: diskNum(data?.gen)! } : {}), text: `orphan flag seen on the claim of client ${client} (the first poll that saw it)` }] } : grown;
    }
    case 'revoke': {
      const revoked = diskList(data?.revoked);
      const ms = diskNum(data?.ms);
      return { ...next, seen: true, events: [...next.events, { t: line.t, what: 'revoke', ...(diskNum(data?.gen) !== undefined ? { gen: diskNum(data?.gen)! } : {}),
        text: `revoked ${revoked.length} delegation${revoked.length === 1 ? '' : 's'}${ms !== undefined ? `; the takeover, revoke and start together, took ${Math.round(ms)} ms` : ''}` }] };
    }
    case 'fenced': {
      const gen = diskNum(data?.gen);
      if (gen === undefined) return next;
      const code = diskStr(data?.code) ?? 'FENCED';
      const grown: DiskState = { ...next, seen: true, events: [...next.events, { t: line.t, what: 'fence', gen, text: `generation ${gen} was fenced: its first refused write (${code}${diskNum(data?.exit) !== undefined ? `, exit ${diskNum(data?.exit)}` : ''})` }] };
      return { ...grown, cuts: [...grown.cuts, ...(grown.durable[gen] ?? [])], incarnations: diskEnd(grown.incarnations, gen, { how: 'fenced', t: line.t, detail: code, box: false }) };
    }
    default:
      return next;
  }
}

/** A paid call (an `agentrun.effects` entry) as the counter fold sees it, in words. */
type DiskCall = { id: string; label: string; path?: string; admitted: number | undefined; verdict: 'once' | 'kept' | 'repeated' | 'twice' | 'in-flight' | 'cut' | 'not-measured' | 'unproven'; applied: number[]; text: string };

function diskCalls(state: DiskState): DiskCall[] {
  return Object.entries(state.counters.effects).map(([id, effect]): DiskCall => {
    const applied = state.counters.appliedIn[id] ?? [];
    const label = state.effects[id]?.label ?? id.split('\u0001')[1]?.split('\u0000').at(-1) ?? id;
    const path = state.effects[id]?.path;
    const base = { id, label, ...(path ? { path } : {}), admitted: effect.admitted, applied };
    const distinct = new Set(applied).size;
    // Repeats come first: a call records each outside call while its effect is still unknown, so two applied calls are a repeat whether or not the effect completed.
    if (applied.length > 1) {
      const tail = effect.status === 'completed' ? '' : ', not completed';
      return distinct === 1
        ? { ...base, verdict: 'twice', text: `made ${applied.length} times in generation ${applied[0]}, which no kill explains${tail}` }
        : { ...base, verdict: 'repeated', text: `made ${applied.length} times (generations ${applied.join(', ')})${tail}` };
    }
    if (effect.status === 'completed') {
      const settler = state.settled[id];
      // The call was paid by the generation that admitted the effect and killed before the store recorded it; the next process settled it from the kept answer without calling again.
      if (applied.length === 1 && settler !== undefined && effect.admitted !== undefined && effect.admitted < settler) {
        return { ...base, verdict: 'kept', text: `made once in generation ${effect.admitted}, kept, settled by generation ${settler} (not repeated)` };
      }
      if (applied.length === 1) return { ...base, verdict: 'once', text: `made once, in generation ${applied[0]}` };
      return state.counters.reported[id]
        ? { ...base, verdict: 'unproven', text: 'completed, but no applied call is recorded: no payment is proven' }
        : { ...base, verdict: 'not-measured', text: 'completed; the host reported no calls, so once-ness is not measured' };
    }
    const alive = !state.ended && effect.admitted !== undefined && effect.admitted === state.counters.lastGen && !state.cuts.includes(effect.admitted);
    return alive ? { ...base, verdict: 'in-flight', text: `in flight in generation ${effect.admitted}` }
      : { ...base, verdict: 'cut', text: `cut in generation ${effect.admitted ?? '?'} before it finished: unknown, not sent again` };
  });
}

const diskDim = (path: string | undefined, focus: string | undefined) => (focus !== undefined && path !== undefined && !under(path, focus) ? ' dim' : '');

function diskLane(incarnation: DiskIncarnation, horizon: number, lastT: number): Node {
  const to = incarnation.end?.t ?? lastT;
  const x = (incarnation.from / horizon) * 100;
  const w = Math.max(1.5, ((to - incarnation.from) / horizon) * 100);
  const how = incarnation.end?.how ?? 'holding';
  const label = incarnation.end
    ? `${how === 'released' ? `released (${incarnation.end.detail})${incarnation.sealedSeq !== undefined ? ` · sealed ${incarnation.sealedSeq}` : ''}` : how === 'killed' ? `${incarnation.end.box ? 'box taken away' : 'killed'}: ${incarnation.end.detail}` : how === 'fenced' ? `fenced: ${incarnation.end.detail}` : 'replaced by the next generation'} at ${diskTime(incarnation.end.t)}`
    : 'holds the run now';
  return h('div', { class: 'dk-lane' },
    h('span', { class: 'dk-name', title: diskHolderText(incarnation.holder) }, `gen ${incarnation.gen}`),
    h('div', { class: 'dk-track' }, h('div', { class: `dk-bar ${how}`, box: { x, y: 0, w: Math.min(w, 100 - x), h: 100 } })),
    h('span', { class: `dk-end ${how}` }, `${diskTime(incarnation.from)} · ${diskHolderText(incarnation.holder)} · ${label}`));
}

function diskView(state: DiskState, context: ViewContext): Node {
  if (!state.seen) return h('div', { class: 'disk' }, h('p', { class: 'empty' }, 'No claim on a disk is in this recording.'));
  const horizon = Math.max(state.lastT, 1);
  const holding = state.incarnations.at(-1);
  const calls = diskCalls(state);
  const once = calls.filter((call) => call.verdict === 'once' || call.verdict === 'kept').length;
  const keptCalls = calls.filter((call) => call.verdict === 'kept').length;
  const repeated = calls.filter((call) => call.verdict === 'repeated' || call.verdict === 'twice').length;
  const cut = calls.filter((call) => call.verdict === 'cut').length;
  const unproven = calls.filter((call) => call.verdict === 'unproven').length;
  return h('div', { class: 'disk' },
    h('div', { class: 'dk-badges' },
      holding && holding.end === undefined && h('span', { class: 'dk-badge ok' }, `generation ${holding.gen} holds the run`),
      holding?.end?.how === 'released' && h('span', { class: 'dk-badge ok' }, `released${holding.sealedSeq !== undefined ? ` · sealed at sequence ${holding.sealedSeq}` : ''}`),
      holding?.end && holding.end.how !== 'released' && h('span', { class: 'dk-badge red' }, `no holder: generation ${holding.gen} ${holding.end.how === 'killed' ? (holding.end.box ? 'lost its box' : 'was killed') : holding.end.how === 'fenced' ? 'was fenced' : 'was replaced'}`),
      state.record && h('span', { class: 'dk-badge' }, `run.json: ${state.record.status}, generation ${state.record.generation}`),
      state.incarnations.length > 1 && h('span', { class: 'dk-badge' }, `${state.incarnations.length} claims`)),
    h('div', { class: 'dk-lanes', title: `0 to ${diskTime(horizon)}; now ${diskTime(context.t)}` }, ...state.incarnations.map((each) => diskLane(each, horizon, state.lastT))),
    h('h5', {}, 'The claim'),
    state.events.length === 0 ? h('p', { class: 'empty' }, 'No claim event yet.')
      : h('ol', { class: 'dk-events' }, ...state.events.map((event) => h('li', { class: `dk-ev ${event.what}` }, h('span', { class: 'dk-t' }, diskTime(event.t)), ` ${event.text}`))),
    h('h5', {}, 'Paid calls'),
    calls.length === 0 ? h('p', { class: 'empty' }, 'No paid call is in the store yet.')
      : h('div', {},
        h('p', { class: 'dk-sum' }, `${calls.length} paid call${calls.length === 1 ? '' : 's'}: ${once} made once${keptCalls > 0 ? ` (${keptCalls} kept and settled by the next generation)` : ''}${repeated > 0 ? `, ${repeated} repeated` : ''}${cut > 0 ? `, ${cut} cut by a kill` : ''}${unproven > 0 ? `, ${unproven} with no applied call` : ''}`),
        h('ul', { class: 'dk-calls' }, ...calls.map((call) => h('li', { class: `dk-call ${call.verdict}${diskDim(call.path, context.focus)}`, ...(call.path ? { path: call.path } : {}) },
          h('span', { class: 'dk-label' }, call.label), h('span', { class: `dk-verdict ${call.verdict}` }, call.text))))));
}

export const diskPanel: Panel<DiskState> = {
  id: 'disk',
  title: 'The disk: who holds the run',
  init: diskInit,
  accepts: (line) => diskKnown(line) || counterFold.accepts(line),
  // Drawn only for a recording with a disk claim line: the counters' lines it reduces for the paid calls must not make it appear everywhere.
  shows: (line) => isSupervisor(line) && DISK_KINDS.has(line.kind),
  reduce: diskReduce,
  view: diskView,
};

register(diskPanel);
