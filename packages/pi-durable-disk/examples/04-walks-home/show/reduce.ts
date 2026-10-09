// ShowState is the fold of ShowEvents. Pure: no clock, no I/O, so the same events give the same state on every page.
import type { Place, ShowEvent, ShowState, Universe } from "./types.ts";

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
    case "place":
      return { ...state, now, place: event.place, currentEnv: event.env };
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
      return { ...state, now, notes: [...state.notes, { at: event.at, kind: event.kind, text: event.text, ...(event.measured !== undefined ? { measured: event.measured } : {}), ...(event.evidence !== undefined ? { evidence: event.evidence } : {}) }].slice(-200) };
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
