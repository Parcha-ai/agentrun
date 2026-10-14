// The transport panel's stage: the session token and where it is, drawn so a stranger gets the story in half a minute. One row per lane
// (an environment: laptop, a Docker box, a Daytona sandbox, a Modal GPU box, home), a rail down the left, and the token, a badge with the
// epoch, that rides the rail. A flight is shown by its own phases: the token sits while the box drains and seals, becomes a sealed packet that
// flies the rail while the bytes ship, and unpacks when the target takes and resumes it. A box kill is a red flash on the lane with the token left
// as a ghost, and the token reappearing, popped in, in the rebuilt box; a process kill is a blink in place. A wait the film skips is a hatched
// band with its seconds. The browser tile sits beside the lane it runs in, and the film's card closes the story.
//
// ONE source of truth for "where": `whereOf` says whether the session is at a lane, moving between two, or gone with its box, and the token, the
// lanes' marks and the status line are all drawn from that one answer, so no two of them can disagree at any stop.
//
// Pure: everything here is a function of the reduced state and the playback clock `now` (the time of the point at a stop, so a scrub shows the same
// screen as a replay). Motion is not animation by wall time: each moving thing gets its position or its `age` (seconds since its event) as a CSS
// variable, and the stylesheet draws the frame for that age with a paused animation, so the screen at a time is the same screen every time.
import { h, type Node } from './panels.ts';
import type { BoxLife, Flight, TransportState } from './transport.ts';

const PHASES = ['prepare', 'drain', 'seal', 'ship', 'take', 'resume', 'retire'] as const;
const PHASE_WORDS: Record<string, string> = { prepare: 'preparing', drain: 'draining to rest', seal: 'sealing', ship: 'shipping', take: 'taking', resume: 'resuming', retire: 'retiring the old box' };

const secs = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);
const laneOfBox = (state: TransportState, box: string | undefined): string | undefined => state.boxes.find((each) => each.box === box)?.lane;
/** The lanes in the order they first appear. */
export const laneNamesOf = (state: TransportState): string[] => [...new Set(state.boxes.map((box) => box.lane))];
const ease = (p: number) => p * p * (3 - 2 * p);

/** Where the session is: at a lane, moving from one to another (with the phase it is in), or gone with its box. */
export type Place =
  | { kind: 'at'; lane: string }
  | { kind: 'moving'; from: string; to: string; phase: string; landed: boolean }
  | { kind: 'gone'; lane: string };

/** The one answer every surface of the stage reads. */
export function whereOf(state: TransportState): Place | undefined {
  const token = state.token;
  if (token === undefined) return undefined;
  const here = laneOfBox(state, token.box);
  if (here === undefined) return undefined;
  if (token.awaiting !== undefined) return { kind: 'gone', lane: here };
  const last = state.pending.at(-1);
  if (last !== undefined) {
    // The flight is under way: its target is the newest box alive in another lane.
    const target = [...state.boxes].reverse().find((box) => box.to === undefined && box.lane !== here);
    if (target !== undefined) return { kind: 'moving', from: here, to: target.lane, phase: last.step, landed: state.pending.some((step) => step.step === 'take') };
  }
  return { kind: 'at', lane: here };
}

/** What the token is doing at `now`. */
type Motion = {
  row: number;
  look: 'rest' | 'drain' | 'seal' | 'ship' | 'take' | 'resume' | 'ghost';
  /** Seconds since the thing that makes it move (the phase began, the kill, the arrival). */
  age: number;
  blink: boolean;
  pop: 'land' | 'reborn' | undefined;
  from?: number;
  to?: number;
};

function motionOf(state: TransportState, place: Place, lanes: string[], now: number): Motion {
  const age = (since: number) => Math.max(0, (now - since) / 1000);
  const row = (lane: string) => Math.max(0, lanes.indexOf(lane));
  if (place.kind === 'gone') return { row: row(place.lane), look: 'ghost', age: age(state.token!.awaiting!), blink: false, pop: undefined };
  if (place.kind === 'moving') {
    const from = row(place.from);
    const to = row(place.to);
    const ship = state.pending.find((step) => step.step === 'ship');
    // The bytes are in flight from `ship` until `take`: the token's way along the rail is that time. While the end is not known yet (the `take`
    // line has not happened) it covers most of the rail, and the rest when `take` lands.
    const progress = place.landed ? 1 : ship === undefined ? 0 : 0.92 * (1 - Math.exp(-Math.max(0, now - ship.t) / 1800));
    const look = (['drain', 'seal', 'ship', 'take', 'resume'] as const).find((phase) => phase === place.phase) ?? 'rest';
    return { row: from + (to - from) * ease(progress), look, age: age(state.pending.at(-1)!.t), blink: false, pop: undefined, from, to };
  }
  const token = state.token!;
  const blink = state.kills.some((kill) => kill.kind === 'process' && kill.t <= now && now - kill.t < 1200);
  const afterBoxKill = state.kills.some((kill) => kill.kind === 'box' && kill.recovered?.box === token.box);
  const recent = now - token.since < 1400;
  return { row: row(place.lane), look: 'rest', age: age(token.since), blink, pop: recent && token.since > 0 ? (afterBoxKill ? 'reborn' : 'land') : undefined };
}

/** The status line over the stage, from the same place. */
function story(state: TransportState, place: Place | undefined, now: number, why: string | undefined): Node {
  const reason = h('div', { class: 'why' }, `Why here: ${why ? `chosen by ${why}` : 'by config (no placement record in this recording)'}`);
  if (place === undefined) return h('div', { class: 'tstory' }, h('b', {}, 'The session is starting.'), reason);
  const epoch = state.token?.epoch !== null && state.token?.epoch !== undefined ? `, epoch ${state.token.epoch}` : '';
  if (place.kind === 'gone') {
    const checkpoint = state.checkpoints.at(-1);
    return h('div', { class: 'tstory dead' }, h('b', {}, `${place.lane} was killed.`), ` The session was at ${place.lane}${epoch} — its box is gone; awaiting recovery from ${checkpoint ? `the checkpoint at head ${checkpoint.head}` : 'its last checkpoint'}.`, reason);
  }
  if (place.kind === 'moving') {
    const done = new Map(state.pending.map((step, index) => [step.step, (state.pending[index + 1]?.t ?? now) - step.t]));
    const reached = new Set(state.pending.map((step) => step.step));
    return h('div', { class: 'tstory flying' },
      h('b', {}, `Moving ${place.from} → ${place.to}`), `, ${PHASE_WORDS[place.phase] ?? place.phase}.`,
      h('ol', { class: 'phases' }, ...PHASES.map((phase) => h('li', { class: `phase ${place.phase === phase ? 'now' : reached.has(phase) ? 'done' : 'todo'}` }, phase, reached.has(phase) && done.get(phase) !== undefined && ` ${done.get(phase)! >= 1000 ? secs(done.get(phase)!) : `${Math.round(done.get(phase)!)} ms`}`))),
      reason);
  }
  const killed = state.kills.at(-1);
  const back = killed?.recovered;
  const recovered = killed !== undefined && back !== undefined && now >= killed.t + back.afterMs && now - back.afterMs - killed.t < 12_000;
  return h('div', { class: 'tstory' }, h('b', {}, `The session is at ${place.lane}`), `${epoch}.`, recovered ? ` Back from ${killed.kind === 'box' ? 'a whole-box kill' : 'a process kill'} after ${secs(back.afterMs)}.` : '', reason);
}

/** The box a lane shows now: its newest. */
const currentBox = (state: TransportState, lane: string): BoxLife | undefined => [...state.boxes].reverse().find((box) => box.lane === lane);

/** The mark a lane carries for the session: `here` at rest, `leaving` and `arriving` during a flight, nothing elsewhere. */
export const markOf = (place: Place | undefined, lane: string): 'here' | 'leaving' | 'arriving' | undefined =>
  place === undefined ? undefined : place.kind === 'at' ? (place.lane === lane ? 'here' : undefined) : place.kind === 'moving' ? (place.from === lane ? 'leaving' : place.to === lane ? 'arriving' : undefined) : undefined;

function laneCard(state: TransportState, place: Place | undefined, lane: string, index: number, now: number, end: number): Node {
  const box = currentBox(state, lane)!;
  const kill = [...state.kills].reverse().find((each) => each.box !== null && state.boxes.some((b) => b.box === each.box && b.lane === lane) && each.kind === 'box');
  const processKill = [...state.kills].reverse().find((each) => each.kind === 'process' && each.box !== null && state.boxes.some((b) => b.box === each.box && b.lane === lane));
  const flashAge = kill !== undefined && kill.box === box.box ? Math.max(0, (now - kill.t) / 1000) : Infinity;
  const gone = box.ended === 'killed';
  const rebuilt = state.boxes.filter((each) => each.lane === lane).length > 1 && !gone;
  const waits = state.waits.filter((wait) => (state.boxes.find((b) => b.box === wait.box)?.lane ?? wait.environment) === lane);
  const status = gone ? '✗ killed' : box.to === undefined ? `alive ${secs(Math.max(0, now - box.from))}` : `ran ${secs(box.to - box.from)}`;
  const facts = `${box.provider}${box.gpu ? `, ${box.gpu}` : ''}${box.isolation && box.isolation !== 'container' && box.isolation !== 'none' ? `, ${box.isolation}` : ''}`;
  const mark = markOf(place, lane);
  const epoch = state.token?.epoch !== null && state.token?.epoch !== undefined ? ` · epoch ${state.token.epoch}` : '';
  const phase = place?.kind === 'moving' ? (PHASE_WORDS[place.phase] ?? place.phase) : '';
  return h('div', { class: `tlane${mark === 'here' ? ' has-token' : ''}${mark === 'arriving' ? ' arriving' : ''}${gone ? ' dead' : ''}${flashAge < 2.4 ? ' flash' : ''}`, vars: { 'flash-age': Number.isFinite(flashAge) ? flashAge : 99, row: index } },
    h('span', { class: 'tdot' }),
    h('div', { class: 'tcard' },
      h('div', { class: 'thead' },
        h('b', { class: 'lname' }, lane), h('span', { class: 'tfacts' }, ` ${facts}`), h('span', { class: 'tstatus' }, ` ${status}`),
        mark === 'here' && h('span', { class: 'tnote mark here' }, `● the session is here${epoch}`),
        mark === 'leaving' && place?.kind === 'moving' && h('span', { class: 'tnote mark leaving' }, `→ moving to ${place.to}`),
        mark === 'arriving' && h('span', { class: 'tnote mark arriving' }, `↘ arriving: ${phase}`),
        rebuilt && h('span', { class: 'tnote' }, '↺ rebuilt from the checkpoint'),
        gone && kill !== undefined && h('span', { class: 'tnote kill' }, `✗ ${kill.label}`),
        !gone && processKill !== undefined && processKill.t <= now && h('span', { class: `tnote proc${now - processKill.t < 1200 ? ' blinking' : ''}` }, `✗ runner killed: ${processKill.recovered ? `back in ${secs(processKill.recovered.afterMs)}` : 'not back yet'}`),
        ...waits.map((wait) => h('span', { class: 'skipband', vars: { age: Math.max(0, (now - wait.t) / 1000) } }, `skipped ${secs(wait.ms)} waiting for ${wait.what}`))),
      h('div', { class: 'tcells' }, ...cellsOf(state, lane, end))),
    state.tile !== undefined && state.tileBox !== undefined && laneOfBox(state, state.tileBox) === lane ? h('div', { class: 'ttile' }, { tag: 'frame', session: state.tile }) : h('div', { class: 'ttile none' }));
}

const BUCKETS = 48;
const bucketOf = (t: number, end: number) => Math.min(BUCKETS - 1, Math.floor((Math.max(0, t) / Math.max(end, 1)) * BUCKETS));

/** One lane over the run so far, a cell each: a box alive, the session there, a kill, a wait skipped (hatched). */
export function cellsOf(state: TransportState, lane: string, end: number): Node[] {
  const cells = Array.from({ length: BUCKETS }, () => new Set<string>());
  for (const box of state.boxes.filter((each) => each.lane === lane)) for (let at = bucketOf(box.from, end); at <= bucketOf(box.to ?? end, end); at += 1) cells[at]!.add('alive');
  for (const segment of state.tokens) if (laneOfBox(state, segment.box) === lane) for (let at = bucketOf(segment.from, end); at <= bucketOf(segment.to ?? end, end); at += 1) cells[at]!.add('token');
  for (const kill of state.kills) if (laneOfBox(state, kill.box ?? undefined) === lane) cells[bucketOf(kill.t, end)]!.add(kill.kind === 'box' ? 'kill-box' : 'kill-process');
  for (const wait of state.waits) if ((state.boxes.find((b) => b.box === wait.box)?.lane ?? wait.environment) === lane) for (let at = bucketOf(Math.max(0, wait.t - wait.ms), end); at <= bucketOf(wait.t, end); at += 1) cells[at]!.add('wait');
  return cells.map((flags) => h('span', { class: `cell ${[...flags].join(' ')}`.trim() }));
}

/** The token itself, over the rail. */
function tokenNode(state: TransportState, motion: Motion): Node {
  const epoch = state.token?.epoch;
  // The checkpoint the session came back from: the restore's own, or (before its line is in) the newest the host took.
  const head = motion.pop === 'reborn' ? (state.flights.findLast((flight) => flight.kind === 'restore')?.checkpoint?.head ?? state.checkpoints.at(-1)?.head) : undefined;
  return h('div', { class: `tok look-${motion.look}${motion.blink ? ' blink' : ''}${motion.pop ? ` pop ${motion.pop}` : ''}`, vars: { row: motion.row, age: motion.age }, title: 'the session' },
    h('span', { class: 'tbadge' }, epoch === null || epoch === undefined ? 'session' : `e${epoch}`),
    motion.look === 'ghost' && h('span', { class: 'tcap' }, 'waiting'),
    head !== undefined && h('span', { class: 'tcap' }, `↺ head ${head}`),
    (motion.look === 'seal' || motion.look === 'ship') && h('span', { class: 'tcap' }, motion.look === 'seal' ? 'sealed' : 'shipping'));
}

/** When each count last changed, for the pulse that tells the eye which one moved. */
export function changedAt(state: TransportState): Record<string, number> {
  return {
    processes: state.runners.at(-1)?.from ?? -1,
    survived: Math.max(-1, ...state.kills.flatMap((kill) => (kill.recovered ? [kill.t + kill.recovered.afterMs] : []))),
    flights: state.flights.at(-1)?.t ?? -1,
    checkpoints: state.checkpoints.at(-1)?.t ?? -1,
    bytes: state.flights.findLast((flight) => flight.bytes !== null)?.t ?? -1,
  };
}

/** The film's card: the end of the story. */
function filmCard(state: TransportState, moves: Flight[], survived: number): Node | false {
  if (state.result === undefined) return false;
  const places = laneNamesOf(state).length;
  return h('div', { class: 'filmcard' },
    h('div', { class: 'ftitle' }, state.result.title),
    h('div', { class: 'fsub' }, `${places} place${places === 1 ? '' : 's'}, ${moves.length} move${moves.length === 1 ? '' : 's'}, ${survived} kill${survived === 1 ? '' : 's'} survived`),
    state.result.blob !== '' && { tag: 'a', blob: state.result.blob, text: 'Open the film', class: 'fbutton' });
}

/** The whole stage. */
export function stageView(state: TransportState, now: number, end: number): Node {
  const lanes = laneNamesOf(state);
  const place = whereOf(state);
  const motion = place === undefined ? undefined : motionOf(state, place, lanes, now);
  const why = state.flights.findLast((flight) => flight.why !== undefined)?.why;
  const survived = state.kills.filter((kill) => kill.recovered !== undefined).length;
  return h('div', { class: 'tstage-wrap' },
    story(state, place, now, why),
    h('div', { class: 'stage', vars: { rows: lanes.length } },
      h('div', { class: 'rail' }),
      motion?.from !== undefined && motion.to !== undefined && motion.from !== motion.to && h('div', { class: 'beam', vars: { a: Math.min(motion.from, motion.to), b: Math.max(motion.from, motion.to) } }),
      ...lanes.map((lane, index) => laneCard(state, place, lane, index, now, end)),
      motion !== undefined && tokenNode(state, motion)),
    h('p', { class: 'legend' }, 'the token is the session · box alive · ✗ killed · hatched: skipped waiting'),
    filmCard(state, state.flights.filter((flight) => flight.kind === 'move'), survived));
}
