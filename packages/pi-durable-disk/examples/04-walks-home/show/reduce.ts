// ShowState is the fold of ShowEvents. Pure: no clock, no I/O, so the same events give the same state on every page.
import { routingKey } from "./robot-events.ts";
import type { Place, ShowEvent, ShowState, Thread, Universe } from "./types.ts";

export function emptyState(): ShowState {
  return {
    source: "live",
    origin: 0,
    now: 0,
    run: "",
    place: { where: "parked" } satisfies Place,
    universes: {},
    stays: [],
    cost: { usd: 0, ratePerMin: 0 },
    notes: [],
    chat: [],
    brain: null,
    brainReady: null,
    net: null,
    checkin: null,
    routing: null,
    routings: [],
    homecoming: null,
    tools: [],
    threads: [],
    robotBody: null,
    decision: null,
    setup: null,
    versions: [],
    scoreUnit: "",
    environments: [],
    currentEnv: null,
  };
}

function blankUniverse(id: string, at: number): Universe {
  return {
    id,
    slot: null,
    status: "spare",
    host: "",
    hostKind: "gpu",
    reward: "",
    progress: 0,
    score: null,
    samples: [],
    cost: 0,
    startedAt: null,
    lastEventAt: at,
  };
}

/** Returns a new state; the input is never mutated, so a page can keep the previous one to animate the difference. */
export function reduce(state: ShowState, event: ShowEvent): ShowState {
  const now = Math.max(state.now, event.at);
  switch (event.t) {
    case "run":
      return { ...state, now, run: event.run, origin: event.origin, environments: event.environments, scoreUnit: event.scoreUnit ?? "", source: event.source ?? "live" };
    case "place": {
      // A setup counts only while the run is on a machine: leaving it (home, in transit, parked) cancels an open one without claiming learning began.
      const onMachine = event.place.where === "cloud" || event.place.where === "universes";
      const setup = state.setup && state.setup.endedAt === null && !onMachine ? null : state.setup;
      return { ...state, now, place: event.place, currentEnv: event.env, setup };
    }
    case "stay.begin": {
      if (state.stays.some((s) => s.id === event.stay.id)) return { ...state, now };
      return { ...state, now, stays: [...state.stays, { ...event.stay, to: null }] };
    }
    case "stay.end": {
      // A stay ends once; a repeated end (a feed replayed after a reconnect) must not move its end time.
      const stays = state.stays.map((s) => (s.id === event.id && s.to === null ? { ...s, to: event.at, endedBy: event.endedBy } : s));
      return { ...state, now, stays };
    }
    case "universe": {
      const before = state.universes[event.id] ?? blankUniverse(event.id, event.at);
      const next: Universe = { ...before, ...event.patch, id: event.id, lastEventAt: event.at };
      return { ...state, now, universes: { ...state.universes, [event.id]: next } };
    }
    case "sample": {
      const before = state.universes[event.id] ?? blankUniverse(event.id, event.at);
      const last = before.samples[before.samples.length - 1];
      // Samples are checkpoints: time only moves forward, so a late duplicate is dropped rather than reordered.
      const samples = last && event.at <= last.at ? before.samples : [...before.samples, { at: event.at, score: event.score }];
      const next: Universe = {
        ...before,
        samples,
        score: samples === before.samples ? before.score : event.score,
        progress: event.progress ?? before.progress,
        cost: event.cost ?? before.cost,
        lastEventAt: event.at,
      };
      return { ...state, now, universes: { ...state.universes, [event.id]: next } };
    }
    case "cost":
      return { ...state, now, cost: event.cost };
    case "note":
      return { ...state, now, notes: [...state.notes, { at: event.at, kind: event.kind, text: event.text, ...(event.measured !== undefined ? { measured: event.measured } : {}), ...(event.evidence !== undefined ? { evidence: event.evidence } : {}), ...(event.rank !== undefined ? { rank: event.rank } : {}), ...(event.group !== undefined ? { group: event.group } : {}), ...(event.urgent !== undefined ? { urgent: event.urgent } : {}), ...(event.keep !== undefined ? { keep: event.keep } : {}), ...(event.showMs !== undefined ? { showMs: event.showMs } : {}) }].slice(-200) };
    case "chat":
      return { ...state, now, chat: event.turns };
    case "brain": {
      const b = event.brain;
      const cur = state.brain;
      // Entry ids only grow along the transcript: an entry no newer than the one held is a repeat (a reload repeats the entries), not news. (An id that is not a number can only be compared for equality.)
      const older = cur !== null && (Number.isFinite(Number(b.id)) && Number.isFinite(Number(cur.id)) ? Number(b.id) <= Number(cur.id) : b.id === cur.id);
      if (older) return { ...state, now };
      if (b.stage === "loading" && cur?.stage === "loading" && cur.sha256 === b.sha256) return { ...state, now };
      // A later entry replaces the held one, a ready one included: a second homecoming (another model, same conversation) writes its own loading, ready or failed entries.
      const brain = { ...b, at: event.at };
      return { ...state, now, brain, brainReady: b.stage === "ready" ? brain : state.brainReady };
    }
    case "net":
      return { ...state, now, net: { ...event.net, at: event.at } };
    case "checkin":
      return { ...state, now, checkin: { ...event.checkin, at: event.at } };
    case "homecoming":
      return { ...state, now, homecoming: { ...event.homecoming, at: event.at } };
    case "body":
      return state.robotBody?.sha === event.sha ? { ...state, now } : { ...state, now, robotBody: { sha: event.sha, at: event.at } };
    case "thread":
    case "thread.point": {
      const i = state.threads.findIndex((t) => t.id === event.id);
      const cur: Thread = i >= 0 ? state.threads[i]! : { id: event.id, skill: null, host: null, status: "starting", acquireMs: null, costUsd: null, metric: null, unit: null, target: null, mjcf: null, bodyName: null, passedS: null, wallS: null, cpuS: null, cpuCores: null, home: false, points: [], at: event.at };
      let next: Thread;
      if (event.t === "thread") {
        const patch = Object.fromEntries(Object.entries(event.patch).filter(([, v]) => v !== undefined));
        next = { ...cur, ...patch, at: event.at };
      } else {
        const last = cur.points.at(-1);
        next = last && last.n >= event.n ? { ...cur, at: event.at } : { ...cur, status: cur.status === "starting" ? "learning" : cur.status, unit: event.unit ?? cur.unit, points: [...cur.points, { n: event.n, value: event.value, at: event.at, passes: event.passes ?? null, fell: event.fell === true, seconds: event.seconds ?? null }].slice(-200), at: event.at };
      }
      const threads = i >= 0 ? state.threads.map((t, j) => (j === i ? next : t)) : [...state.threads, next];
      return { ...state, now, threads };
    }
    case "homecoming.loaded":
      return { ...state, now, homecoming: state.homecoming ? { ...state.homecoming, loadMs: event.loadMs } : null };
    case "tools":
      return { ...state, now, tools: event.tools };
    case "routing": {
      // The same decision told twice (the tab's message and its transcript entry) is one decision.
      const last = state.routing;
      if (last && routingKey(last) === routingKey(event.routing)) return { ...state, now };
      const routing = { ...event.routing, at: event.at };
      return { ...state, now, routing, routings: [...state.routings, routing].slice(-50) };
    }
    case "setup":
      if (event.phase === "start") return { ...state, now, setup: { startedAt: event.at, endedAt: null } };
      // An end is said once, and means nothing without a start.
      return state.setup && state.setup.endedAt === null ? { ...state, now, setup: { ...state.setup, endedAt: event.at } } : { ...state, now };
    case "version": {
      const at = state.versions.findIndex((v) => v.n === event.n);
      const versions = at >= 0 ? state.versions.map((v, i) => (i === at ? { n: event.n, metres: event.metres } : v)) : [...state.versions, { n: event.n, metres: event.metres }];
      return { ...state, now, versions };
    }
    case "decision":
      return { ...state, now, decision: { ...event.decision, at: event.at } };
  }
}

export function fold(events: readonly ShowEvent[], from: ShowState = emptyState()): ShowState {
  return events.reduce(reduce, from);
}

/** The universe in each grid slot, for the 2 x 4 panel. A killed universe holds its slot until a spare takes it. */
export function bySlot(state: ShowState): (Universe | null)[] {
  const cells: (Universe | null)[] = Array.from({ length: 8 }, () => null);
  for (const u of Object.values(state.universes)) if (u.slot !== null && u.slot >= 0 && u.slot < 8) cells[u.slot] = u;
  return cells;
}

export function spares(state: ShowState): Universe[] {
  return Object.values(state.universes).filter((u) => u.status === "spare");
}

/**
 * Machines that died and are no longer in a cell: the tray under the grid. A spare retired unused at collapse is sealed
 * with no slot and is not a casualty, so it is not listed.
 */
export function fallen(state: ShowState): Universe[] {
  return Object.values(state.universes).filter((u) => u.slot === null && u.status === "killed");
}
