// The transport panel: where a session lives, and what happened to it on the way. One lane per environment (a laptop, a Docker box, a
// Daytona sandbox, a Modal GPU box, a Modal VM, home), the token that is the session and the flights it made from lane to lane, the
// boxes' lifetimes, the kills (a whole box, or only a process) with the arrow to where the session came back, the waits the film skips
// (never cut silently), and the counters.
//
// What it reads (RECORDING.md section 5, transport and host):
//   host (the supervisor's lines): `process.started` (one per runner the host started: its gen, environment and box), `kill` (gen, label,
//     kind box|process, the box), `result`.
//   transport, live: `box.created` / `box.ended` / `box.killed`, `process.killed`, `move.step`, `move`, `restore`, `checkpoint`, `lease`, `wait`.
//   transport, durable: the `transport.moves` document (one key per move id; the record has a top-level `head`, a move's `seal`, a restore's
//     `checkpoint` and `replayed`). Nobody writes it yet; when its lines arrive they replace the live `move` and `restore` lines of the same
//     id, and a restore (3.2) marks the flights of the lost branch as lost, still shown.
//   browser: the latest `frame` session, drawn as the tile of the lane the session was in.
// A count is proven only from the supervisor's host lines and from durable lines. A flight known only from a live line is "observed", and
// the panel says so: it is drawn, never counted as proven (RECORDING.md section 4 rule 1). Paid calls, repeated and cost come from the
// shell's own counter fold, and a cost that is null is "unknown", never $0; a recording with no durable line says "not measured".
//
// Pure: `accepts`, `reduce` and `view` read only their arguments. A scrub is a replay: the screen at a stop is the reduce of the lines
// before it. Kinds it does not know are skipped.
import { counterFold, countersOf, repeatedLabel, type CounterState } from './counters.ts';
import { docOf } from './durable.ts';
import { isSupervisor, processOf, type Json, type Line } from './format.ts';
import { h, register, type Node, type Panel } from './panels.ts';

type Obj = { [key: string]: Json };
const obj = (value: Json | undefined): Obj | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined);
const str = (value: Json | undefined): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: Json | undefined): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export type Where = { environment: string; provider: string; box: string };
export type Step = { step: string; t: number };
export type Flight = {
  id: string;
  kind: 'move' | 'restore';
  /** Proven by a durable `transport.moves` line, or only observed in a live line. */
  proof: 'durable' | 'observed';
  from: Where | null;
  to: Where;
  epoch: number | null;
  head: number | null;
  t: number;
  steps: Step[];
  drainMs: number | null;
  shipMs: number | null;
  bytes: number | null;
  /** A restore's checkpoint, and what it left out of the files. */
  checkpoint?: { head: number; bytes: number | null; at: string | null; excluded: string[] };
  /** A flight whose commit the store went back over: it happened, and the restored store does not hold it. */
  lost: boolean;
  commit?: number;
  why?: string;
};
export type BoxLife = { box: string; environment: string; provider: string; isolation: string | null; gpu: string | null; cpus: number | null; from: number; to?: number; ended?: 'ended' | 'killed' };
export type Runner = { gen: number; environment: string; box: string; from: number; to?: number };
export type Kill = { t: number; gen: number; kind: 'box' | 'process'; label: string; box: string | null; recovered?: { gen: number; box: string; afterMs: number } };
export type Wait = { t: number; box: string; environment: string; ms: number; what: string };
export type CheckpointRecord = { n: number; head: number; bytes: number | null; t: number; excluded: string[] };

export type TransportState = {
  boxes: BoxLife[];
  runners: Runner[];
  flights: Flight[];
  kills: Kill[];
  waits: Wait[];
  checkpoints: CheckpointRecord[];
  pending: Step[];
  /** Where the session lives: the box the latest lease (or, before one, the first runner) names. */
  token: { box: string; epoch: number | null; since: number } | undefined;
  tokens: { box: string; from: number; to?: number }[];
  tile: string | undefined;
  result: { blob: string; title: string } | undefined;
  lastT: number;
  durableLines: number;
  /** The durable restore detection of RECORDING.md 3.2, for the flights a durable document names. */
  highest: number;
  inSnapshot: boolean;
  opened: boolean;
  counters: CounterState;
};

const KINDS = new Set(['box.created', 'box.ended', 'box.killed', 'process.killed', 'move.step', 'move', 'restore', 'checkpoint', 'lease', 'wait']);
const where = (value: Json | undefined): Where | null => {
  const at = obj(value);
  const box = str(at?.box);
  return at && box !== undefined ? { environment: str(at.environment) ?? '?', provider: str(at.provider) ?? '?', box } : null;
};
const excluded = (value: Json | undefined): string[] => {
  const left = obj(value);
  return Array.isArray(left?.patterns) ? left.patterns.filter((pattern): pattern is string => typeof pattern === 'string') : [];
};

const known = (line: Line): boolean => {
  if (line.source === 'transport') return line.channel === 'live' ? KINDS.has(line.kind) : docOf(line)?.doc === 'transport.moves';
  if (isSupervisor(line)) return line.kind === 'process.started' || line.kind === 'kill' || line.kind === 'result';
  if (line.source === 'browser') return line.kind === 'frame';
  return false;
};

const initial = (): TransportState => ({ boxes: [], runners: [], flights: [], kills: [], waits: [], checkpoints: [], pending: [], token: undefined, tokens: [], tile: undefined, result: undefined, lastT: 0, durableLines: 0, highest: -1, inSnapshot: false, opened: false, counters: counterFold.init() });

const moveRecords = (line: Line): { id: string; value: Obj }[] => {
  const doc = docOf(line);
  const value = obj(doc?.value);
  if (doc?.doc !== 'transport.moves' || value === undefined) return [];
  const listed = Array.isArray(value.moves) ? value.moves.flatMap((each) => { const record = obj(each); return record ? [record] : []; }) : [value];
  return listed.map((record, index) => ({ id: str(record.id) ?? doc.key ?? `move-${line.commit ?? 0}-${index}`, value: record }));
};

const flightOf = (id: string, data: Obj, line: Line, proof: Flight['proof']): Flight => {
  const checkpoint = obj(data.checkpoint);
  const seal = obj(data.seal);
  const kind = data.kind === 'restore' ? 'restore' : 'move';
  const placement = obj(data.placement);
  return {
    id, kind, proof, from: where(data.from), to: where(data.to) ?? { environment: '?', provider: '?', box: '?' },
    epoch: num(data.epoch) ?? null, head: num(data.head) ?? null, t: line.t, steps: [], drainMs: num(data.drainMs) ?? null, shipMs: num(data.shipMs) ?? null,
    bytes: num(data.bytes) ?? num(seal?.bytes) ?? null,
    ...(checkpoint ? { checkpoint: { head: num(checkpoint.head) ?? -1, bytes: num(checkpoint.bytes) ?? null, at: str(checkpoint.at) ?? null, excluded: excluded(data.excluded) } } : {}),
    lost: false, ...(line.commit !== undefined ? { commit: line.commit } : {}),
    ...(str(placement?.by) !== undefined ? { why: `${str(placement?.by)}${str(placement?.id) ? ` (${str(placement?.id)})` : ''}` } : {}),
  };
};

const upsert = (flights: Flight[], flight: Flight): Flight[] => {
  const at = flights.findIndex((each) => each.id === flight.id);
  if (at < 0) return [...flights, flight];
  // A durable record replaces what a live line said of the same move; a live line never replaces a durable one.
  if (flights[at]!.proof === 'durable' && flight.proof === 'observed') return flights;
  return flights.map((each, index) => (index === at ? { ...flight, steps: each.steps.length ? each.steps : flight.steps } : each));
};

const tokenTo = (state: TransportState, box: string, epoch: number | null, t: number): TransportState => {
  if (state.token?.box === box && state.token.epoch === epoch) return state;
  const tokens = state.tokens.map((segment, index) => (index === state.tokens.length - 1 && segment.to === undefined ? { ...segment, to: t } : segment));
  return { ...state, token: { box, epoch, since: t }, tokens: [...tokens, { box, from: t }] };
};

export const transportPanel: Panel<TransportState> = {
  id: 'transport',
  title: 'Where the session lives',
  init: initial,
  accepts: (line) => known(line) || counterFold.accepts(line),
  reduce(before, line) {
    let state: TransportState = { ...before, lastT: Math.max(before.lastT, line.t) };
    if (counterFold.accepts(line)) state = { ...state, counters: counterFold.reduce(state.counters, line) };
    if (line.channel === 'durable') {
      if (line.commit === undefined) return state;
      state = { ...state, durableLines: state.durableLines + 1 };
      // The store going back over a checkpoint (3.2): the flights of the commits above it are the lost branch.
      const first = line.snapshot === true && (before.opened || !before.inSnapshot);
      let { highest } = before;
      let flights = state.flights;
      if (first && line.commit < highest) { flights = flights.map((flight) => (flight.commit !== undefined && flight.commit > line.commit! ? { ...flight, lost: true } : flight)); highest = line.commit; } else highest = Math.max(highest, line.commit);
      state = { ...state, highest, inSnapshot: line.snapshot === true, opened: before.opened && line.snapshot !== true, flights };
      for (const { id, value } of moveRecords(line)) state = { ...state, flights: upsert(state.flights, flightOf(id, value, line, 'durable')) };
      return state;
    }
    const data = obj(line.data) ?? {};
    if (isSupervisor(line)) {
      if (line.kind === 'process.started') {
        const gen = processOf(line) ?? state.runners.length + 1;
        const box = str(data.box) ?? '?';
        const runners = [...state.runners.map((runner) => (runner.to === undefined && runner.gen !== gen ? { ...runner, to: line.t } : runner)), { gen, environment: str(data.environment) ?? '?', box, from: line.t }];
        // The first runner is where the session starts; each kill waits for the next runner to be answered by an arrow.
        const kills = state.kills.map((kill) => (kill.recovered === undefined ? { ...kill, recovered: { gen, box, afterMs: Math.max(0, line.t - kill.t) } } : kill));
        state = { ...state, runners, kills, opened: true };
        return state.token === undefined ? tokenTo(state, box, null, line.t) : state;
      }
      if (line.kind === 'kill') {
        const kind = data.kind === 'process' ? 'process' : 'box';
        return { ...state, kills: [...state.kills, { t: line.t, gen: processOf(line) ?? 0, kind, label: str(data.label) ?? 'killed', box: str(data.box) ?? null }] };
      }
      if (line.kind === 'result') return { ...state, result: { blob: str(data.blob) ?? '', title: str(data.title) ?? 'The result' } };
      return state;
    }
    if (line.source === 'browser') return typeof data.session === 'string' ? { ...state, tile: data.session } : state;
    if (line.source !== 'transport') return state;
    switch (line.kind) {
      case 'box.created': {
        const facts = obj(data.facts);
        const box = str(data.box);
        if (box === undefined) return state;
        return { ...state, boxes: [...state.boxes.filter((each) => each.box !== box), { box, environment: str(data.environment) ?? '?', provider: str(data.provider) ?? '?', isolation: str(facts?.isolation) ?? null, gpu: str(facts?.gpu) ?? null, cpus: num(facts?.cpus) ?? null, from: line.t }] };
      }
      case 'box.ended':
      case 'box.killed': {
        const box = str(data.box);
        return { ...state, boxes: state.boxes.map((each) => (each.box === box && each.to === undefined ? { ...each, to: line.t, ended: line.kind === 'box.killed' ? 'killed' : 'ended' } : each.box === box && line.kind === 'box.killed' ? { ...each, ended: 'killed' } : each)) };
      }
      case 'process.killed': return state;
      case 'move.step': return { ...state, pending: [...state.pending, { step: str(data.step) ?? '?', t: line.t }] };
      case 'move':
      case 'restore': {
        const flight = flightOf(str(data.id) ?? `${line.kind}-${state.flights.length + 1}`, data, line, 'observed');
        return { ...state, flights: upsert(state.flights, { ...flight, steps: line.kind === 'move' ? state.pending : [] }), pending: line.kind === 'move' ? [] : state.pending };
      }
      case 'checkpoint': return { ...state, checkpoints: [...state.checkpoints, { n: num(data.n) ?? state.checkpoints.length + 1, head: num(data.head) ?? -1, bytes: num(data.bytes) ?? null, t: line.t, excluded: excluded(data.excluded) }] };
      case 'lease': {
        const holder = obj(data.holder);
        const box = str(holder?.box);
        return box === undefined ? state : tokenTo(state, box, num(data.epoch) ?? null, line.t);
      }
      case 'wait': return { ...state, waits: [...state.waits, { t: line.t, box: str(data.box) ?? '?', environment: str(data.environment) ?? '?', ms: num(data.ms) ?? 0, what: str(data.what) ?? 'something' }] };
      default: return state;
    }
  },
  view(state, context) {
    return view(state, context.t);
  },
};

// ---- the screen ---------------------------------------------------------------------------------------------------

const BUCKETS = 48;
const seconds = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);
const millis = (ms: number | null) => (ms === null ? 'not recorded' : ms >= 1000 ? seconds(ms) : `${Math.round(ms)} ms`);
const size = (bytes: number | null) => (bytes === null ? 'not recorded' : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(0)} KiB` : `${bytes} B`);
const label = (state: TransportState, box: string | null | undefined): string => {
  const life = state.boxes.find((each) => each.box === box);
  return life ? `${life.environment} (${life.provider}${life.gpu ? `, ${life.gpu}` : life.isolation && life.isolation !== 'container' && life.isolation !== 'none' ? `, ${life.isolation}` : ''})` : box ? `box ${box.slice(0, 8)}` : 'a box not recorded';
};

/** The environments in the order they first appear: the lanes. */
const environmentsOf = (state: TransportState): string[] => [...new Set(state.boxes.map((box) => box.environment))];

const bucketOf = (t: number, end: number) => Math.min(BUCKETS - 1, Math.floor((t / Math.max(end, 1)) * BUCKETS));

/** One lane drawn as cells over the run so far: a box alive, the session there, a kill, a wait the film skips. */
function laneCells(state: TransportState, environment: string, end: number): Node[] {
  const cells = Array.from({ length: BUCKETS }, () => new Set<string>());
  const boxesHere = state.boxes.filter((box) => box.environment === environment);
  for (const box of boxesHere) for (let at = bucketOf(box.from, end); at <= bucketOf(box.to ?? end, end); at += 1) cells[at]!.add('alive');
  for (const segment of state.tokens) {
    const env = state.boxes.find((box) => box.box === segment.box)?.environment;
    if (env === environment) for (let at = bucketOf(segment.from, end); at <= bucketOf(segment.to ?? end, end); at += 1) cells[at]!.add('token');
  }
  for (const kill of state.kills) if (boxesHere.some((box) => box.box === kill.box)) cells[bucketOf(kill.t, end)]!.add(kill.kind === 'box' ? 'kill-box' : 'kill-process');
  for (const wait of state.waits) if (wait.environment === environment) for (let at = bucketOf(Math.max(0, wait.t - wait.ms), end); at <= bucketOf(wait.t, end); at += 1) cells[at]!.add('wait');
  return cells.map((flags) => h('span', { class: `cell ${[...flags].join(' ')}`.trim() }));
}

function counters(state: TransportState): Node {
  const strip = countersOf(state.counters, false);
  const boxKills = state.kills.filter((kill) => kill.kind === 'box').length;
  const processKills = state.kills.filter((kill) => kill.kind === 'process').length;
  const survived = state.kills.filter((kill) => kill.recovered !== undefined).length;
  const moves = state.flights.filter((flight) => flight.kind === 'move');
  const restores = state.flights.filter((flight) => flight.kind === 'restore');
  const proven = state.flights.length > 0 && state.flights.every((flight) => flight.proof === 'durable');
  const flightText = `${moves.length} move${moves.length === 1 ? '' : 's'}, ${restores.length} restore${restores.length === 1 ? '' : 's'}${state.flights.length === 0 ? '' : proven ? '' : ' (observed: live lines)'}`;
  const measured = state.durableLines > 0;
  const bytes = state.flights.reduce((sum, flight) => sum + (flight.bytes ?? 0), 0);
  const row = (name: string, value: string, title?: string): Node => h('li', { ...(title ? { title } : {}) }, h('span', { class: 'k' }, name), h('b', {}, value));
  return h('ul', { class: 'tcounters' },
    row('processes', String(state.runners.length), 'runners the host started: its own lines'),
    row('kills survived', `${survived} of ${state.kills.length} (${boxKills} box, ${processKills} process)`, 'a kill is survived when a runner started after it'),
    row('flights', flightText),
    row('checkpoints', String(state.checkpoints.length)),
    row('bytes shipped', state.flights.length ? `${size(bytes)} (observed)` : 'none yet'),
    row('paid calls', measured ? String(strip.paid.total) : 'not measured: no durable lines'),
    row('repeated', measured ? repeatedLabel(strip) : 'not measured: no durable lines'),
    row('cost', !measured ? 'not measured: no durable lines' : strip.cost === null ? 'unknown' : `$${strip.cost.toFixed(4)}`));
}

function flightNode(state: TransportState, flight: Flight): Node {
  const steps = flight.steps.length ? ` · steps: ${flight.steps.map((step) => `${step.step} ${seconds(step.t - flight.steps[0]!.t)}`).join(', ')}` : '';
  const arrow = flight.kind === 'restore' ? '↻ restored' : '→ moved';
  const left = flight.checkpoint?.excluded.length ? ` · left out of the checkpoint: ${flight.checkpoint.excluded.join(', ')}` : '';
  return h('li', { class: `flight ${flight.kind}${flight.lost ? ' lost' : ''}` },
    h('b', {}, arrow), ` ${flight.from ? label(state, flight.from.box) : 'start'} → ${label(state, flight.to.box)}`,
    flight.epoch !== null && ` · epoch ${flight.epoch}`,
    flight.head !== null && ` · head ${flight.head}`,
    flight.kind === 'move' && ` · drain ${millis(flight.drainMs)}, ship ${millis(flight.shipMs)}, ${size(flight.bytes)}`,
    flight.checkpoint && ` · from checkpoint at head ${flight.checkpoint.head}`,
    left, steps,
    h('span', { class: `proof ${flight.proof}` }, flight.proof === 'durable' ? ' proven (durable)' : ' observed (live line)'),
    flight.lost && h('span', { class: 'proof lost' }, ' lost branch: the restored store does not hold it'));
}

function killNode(state: TransportState, kill: Kill): Node {
  const back = kill.recovered
    ? `↳ back in ${seconds(kill.recovered.afterMs)}: process ${kill.recovered.gen} at ${label(state, kill.recovered.box)}`
    : '↳ not recovered yet';
  return h('li', { class: `kill ${kill.kind}` }, h('b', {}, kill.kind === 'box' ? '✗ the whole box' : '✗ a process'), ` — ${kill.label}`, kill.box ? ` (${label(state, kill.box)}, process ${kill.gen})` : ` (process ${kill.gen})`, h('div', { class: 'back' }, back));
}

function view(state: TransportState, now: number): Node {
  if (state.boxes.length === 0 && state.runners.length === 0 && state.flights.length === 0 && state.durableLines === 0) return h('div', { class: 'transport' }, h('p', { class: 'empty' }, 'The session has not started a box yet.'));
  const end = Math.max(state.lastT, now, 1);
  const lanes = environmentsOf(state);
  const home = state.token ? state.boxes.find((box) => box.box === state.token!.box) : undefined;
  const why = state.flights.findLast((flight) => flight.why !== undefined)?.why;
  return h('div', { class: 'transport' },
    h('div', { class: 'token' },
      h('b', {}, 'The session is at '), home ? `${label(state, home.box)}${state.token!.epoch !== null ? `, epoch ${state.token!.epoch}` : ''}` : 'a place not recorded',
      h('div', { class: 'why' }, `Why here: ${why ? `chosen by ${why}` : 'by config (no placement record in this recording)'}`)),
    counters(state),
    h('h4', {}, 'Lanes'),
    h('div', { class: 'lanes' }, ...lanes.map((environment) => h('div', { class: 'lane' }, h('span', { class: 'lname' }, environment), h('span', { class: 'cells' }, ...laneCells(state, environment, end))))),
    h('p', { class: 'legend' }, 'box alive · the session is here · ✗ killed · hatched: skipped waiting'),
    state.tile && h('div', { class: 'tile' }, h('h4', {}, 'The browser, as the box showed it'), { tag: 'frame', session: state.tile }),
    h('h4', {}, 'Flights'),
    state.flights.length === 0 ? h('p', { class: 'empty' }, 'The session has not moved yet.') : h('ol', {}, ...state.flights.map((flight) => flightNode(state, flight))),
    state.kills.length > 0 && h('h4', {}, 'Kills'),
    ...(state.kills.length > 0 ? [h('ul', {}, ...state.kills.map((kill) => killNode(state, kill)))] : []),
    state.waits.length > 0 && h('h4', {}, 'Skipped waiting'),
    ...(state.waits.length > 0 ? [h('ul', {}, ...state.waits.map((wait) => h('li', { class: 'wait' }, `skipped ${seconds(wait.ms)} waiting for ${wait.what} (${wait.environment})`)))] : []),
    h('h4', {}, 'Boxes'),
    h('ul', {}, ...state.boxes.map((box) => h('li', { class: `box${box.ended === 'killed' ? ' killed' : ''}` }, `${box.environment} on ${box.provider}${box.gpu ? `, ${box.gpu}` : ''}${box.isolation ? `, ${box.isolation}` : ''}${box.cpus ? `, ${box.cpus} cpu` : ''}: ${box.to === undefined ? `alive since ${seconds(box.from)}` : `${seconds(box.to - box.from)}${box.ended === 'killed' ? ', killed' : ''}`}`))),
    state.result && h('p', { class: 'result' }, { tag: 'a', blob: state.result.blob, text: state.result.title }));
}

register(transportPanel);
