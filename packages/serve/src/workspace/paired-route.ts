// Where a paired computer's socket goes on a server whose runner runs in a process of its own (the image's
// server-and-runner, `agentrun-serve runner`): its route. The box's driver dials the server's one public address, and
// keeps that one socket. While no run holds the box, the server's own hub takes it; while a run holds it, the server
// relays the same socket to the attach listener of the runner that holds the run (computer-attach.ts, the relay of
// dial-relay.ts), where that runner's hub takes it and the run's hold lives. A move is the server closing the socket with
// 1001 and the box's own redial landing where the route now says; nothing changes on the box.
//
// One server setting per paired computer holds it (`paired_route:<computer id>`): the runner, its incarnation, the run,
// the hold's end (shown, never judged), and a note the server keeps of why a route was refused or dropped. It is written
// by compare-and-set, as computer_kept:<run id> is (computer-kept.ts), the same calls on SQLite and Postgres: the run's
// claim takes it (takeRoute, with the claim, so a superseded claim's take is Fenced), the runner that holds it drops it
// once its hold ended (dropRoute), and the server notes and drops a stale one (replaceRoute). A row exists only while it
// holds a route or a note, so the server's tick reads only rows that matter (one indexed read of the prefix).
//
// A route is stale only when its runner has no live relay (runner/presence.ts liveRelays: no word of it for
// PRESENCE_STALE_MS) or names another incarnation (that runner restarted since); or when its run is final, so a runner's
// release that never dropped its route (its write failed) keeps the box from no other run. A route of another run, on
// a live runner, refuses the take: one run at a time.
import { ATTACH_HELLO_MS, ATTACH_REDIAL_MAX_MS } from "@parcha/agentrun-computer";
import { RELAY_CONNECT_MS } from "../live-reach.js";
import { liveRelays } from "../runner/presence.js";
import { type Claim, FINAL_STATES, type Runners, type Runs, type Settings } from "../store/index.js";

/** The settings key prefix of the paired computers' routes, one row per computer. */
export const ROUTE_PREFIX = "paired_route:";
/** The settings key of computer `id`'s route. */
export const routeKeyOf = (id: string): string => `${ROUTE_PREFIX}${id}`;

/** How often the server compares each route with where the box's socket is (server.ts, computer-attach.ts tick). */
export const PAIRED_ROUTE_MS = 1_000;
/** How long a run's claim waits for its box to reach its runner: one tick of the server's, the driver's longest wait
 *  between dials (it backs off after quick reconnects), the relay's connect and the hub's hello. */
export const PAIRED_BRING_MS = PAIRED_ROUTE_MS + ATTACH_REDIAL_MAX_MS + RELAY_CONNECT_MS + ATTACH_HELLO_MS;
/** How often the claim reads the route while it waits. */
export const PAIRED_BRING_POLL_MS = 500;
/** How many times a take or a drop reads the row again after another writer changed it between its read and its write. */
const ROUTE_TRIES = 5;

/** A paired computer's route: the runner whose hub holds the box for `run` (and that runner's incarnation), the hold's
 *  end (ms), and the server's note of why a route was refused or dropped. All null: no route, the server's hub. */
export type Route = {
  readonly runner: string | null;
  readonly incarnation: string | null;
  readonly run: string | null;
  readonly until: number | null;
  readonly refused: string | null;
};

/** No route and no note. */
export const EMPTY_ROUTE: Route = { runner: null, incarnation: null, run: null, until: null, refused: null };

/** What a run's claim asks: its runner and incarnation, the run, and its hold's end (ms). */
export type RouteWant = { readonly runner: string; readonly incarnation: string; readonly run: string; readonly until: number };

/** The settings the routes live in. */
export type RouteSettings = Pick<Settings, "get" | "putIfAbsent" | "replaceIf" | "removeIf" | "remove" | "all">;

/** What a take reads: the routes, the runners (is the route's runner live), and the runs (is the route's run final). */
export type RouteDeps = {
  readonly settings: Pick<RouteSettings, "get" | "putIfAbsent" | "replaceIf" | "removeIf">;
  readonly runners: Pick<Runners, "live">;
  readonly runs?: Pick<Runs, "get">;
};

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** A row's value as a Route; anything else reads as EMPTY_ROUTE. */
export function routeOf(value: unknown): Route {
  if (!value || typeof value !== "object") return EMPTY_ROUTE;
  const row = value as Record<string, unknown>;
  const runner = text(row.runner);
  const incarnation = text(row.incarnation);
  const refused = text(row.refused);
  // A route names its runner, its incarnation and its run together, or none of them.
  const run = text(row.run);
  if (runner === null || incarnation === null || run === null) return { ...EMPTY_ROUTE, refused };
  const until = typeof row.until === "number" && Number.isFinite(row.until) ? row.until : null;
  return { runner, incarnation, run, until, refused };
}

/** The row as written: its fields in one order, so a compare-and-set reads the same text. */
const rowOf = (route: Route): Route => ({ runner: route.runner, incarnation: route.incarnation, run: route.run, until: route.until, refused: route.refused });

const isEmpty = (route: Route): boolean => route.runner === null && route.refused === null;

/** Computer `id`'s route as its row reads now: EMPTY_ROUTE when there is none. */
export async function readRoute(settings: Pick<RouteSettings, "get">, id: string): Promise<Route> {
  return routeOf(await settings.get(routeKeyOf(id)));
}

/** Computer `id`'s route and its row's value as read (undefined: no row), for a compare-and-set on it. */
export async function seeRoute(settings: Pick<RouteSettings, "get">, id: string): Promise<{ readonly seen: unknown; readonly route: Route }> {
  const seen = await settings.get(routeKeyOf(id));
  return { seen, route: routeOf(seen) };
}

/** Every route row, as the server's tick reads them: one read of the prefix, a range on the settings' primary key. */
export async function allRoutes(settings: Pick<RouteSettings, "all">): Promise<{ readonly id: string; readonly seen: unknown; readonly route: Route }[]> {
  return (await settings.all({ prefix: ROUTE_PREFIX })).map((row) => ({ id: row.key.slice(ROUTE_PREFIX.length), seen: row.value, route: routeOf(row.value) }));
}

/** Writes `next` over computer `id`'s row while it still holds `seen` (as read): one compare-and-set. An empty `next` (no
 *  route, no note) removes the row. False when the row changed since. */
export async function replaceRoute(settings: Pick<RouteSettings, "putIfAbsent" | "replaceIf" | "removeIf">, id: string, seen: unknown, next: Route, claim?: Claim): Promise<boolean> {
  const key = routeKeyOf(id);
  if (seen === undefined) {
    if (isEmpty(next)) return true;
    const there = await settings.putIfAbsent(key, rowOf(EMPTY_ROUTE));
    return replaceRoute(settings, id, there, next, claim);
  }
  if (isEmpty(next) && claim === undefined) return settings.removeIf(key, seen);
  return settings.replaceIf(key, seen, rowOf(next), claim);
}

/** `name` held by another run, on a live runner. */
export const heldWords = (name: string, run: string, runner: string): string => `${name} is held by run ${run} on runner ${runner}: one run at a time`;
/** How a stale route's words end (the server's 503 and the box's note): where the box goes, and when. */
export const ROUTE_COMES_BACK = `it comes back to this server at its next dial, within ${ATTACH_REDIAL_MAX_MS / 1000} s, and the run's next claim takes it again`;
/** What a route says once its runner restarted. The words for a runner gone are the relay's own (computer-attach.ts
 *  relayDial), ending in ROUTE_COMES_BACK. */
export const routeRestartedWords = (runner: string): string => `runner ${runner}, which holds it, restarted since, and the hold was its earlier process's: ${ROUTE_COMES_BACK}`;
/** A box routed to a run's runner, attached nowhere: the claim's wait ends in these words. */
export const notAttachedWords = (name: string): string => `${name} is not attached now: open its driver on that computer, which dials this server`;
/** A box that did not reach its run's runner within PAIRED_BRING_MS. */
export const lateWords = (name: string, runner: string): string =>
  `${name} did not reach runner ${runner} within ${PAIRED_BRING_MS / 1000} s: its driver waits up to ${ATTACH_REDIAL_MAX_MS / 1000} s between dials after quick reconnects, so the run's next claim may find it there`;
/** A take or a drop that lost every compare-and-set to another writer. */
const changedWords = (name: string): string => `${name}'s route changed while this run took it: its next claim tries again`;

/** What a take came to: the route taken (as written), or why not, with the route as it is. */
export type Took = { readonly taken: true; readonly route: Route } | { readonly taken: false; readonly why: string; readonly route: Route };

/** Why `route` keeps computer `name` from `want`'s run, or undefined where the run may take it: no route, the run's own
 *  (a resume on another runner), a route whose runner is not live or restarted since, or one whose run is final. */
async function holdsAgainst(deps: RouteDeps, route: Route, want: RouteWant, name: string): Promise<string | undefined> {
  if (route.runner === null || route.run === want.run) return undefined;
  const at = (await liveRelays(deps.runners)).find((row) => row.runner === route.runner);
  if (at === undefined || at.incarnation !== route.incarnation) return undefined;
  // A run that ended, stopped or failed holds nothing: its runner's release dropped the route, or that write failed. A
  // run the store has no row of is not final: its route stands.
  const run = deps.runs === undefined ? undefined : await deps.runs.get(route.run!);
  if (run !== undefined && FINAL_STATES.includes(run.state)) return undefined;
  return heldWords(name, route.run!, route.runner);
}

/** Routes computer `id` to `want`'s runner for its run, where holdsAgainst lets it: the run's claim, before it waits for
 *  the box (dial-relay.ts bring). With `claim`, the write checks the claim's epoch and lease in its transaction, so a
 *  claim another runner superseded throws Fenced and writes nothing. `name` is the computer's, for the words. */
export async function takeRoute(deps: RouteDeps, id: string, want: RouteWant, { claim, name = id }: { readonly claim?: Claim; readonly name?: string } = {}): Promise<Took> {
  const mine = rowOf({ runner: want.runner, incarnation: want.incarnation, run: want.run, until: want.until, refused: null });
  let route = EMPTY_ROUTE;
  for (let tried = 0; tried < ROUTE_TRIES; tried++) {
    const read = await seeRoute(deps.settings, id);
    route = read.route;
    const why = await holdsAgainst(deps, route, want, name);
    if (why !== undefined) return { taken: false, why, route };
    if (await replaceRoute(deps.settings, id, read.seen, mine, claim)) return { taken: true, route: mine };
  }
  return { taken: false, why: changedWords(name), route };
}

/** Drops computer `id`'s route where it is `mine` (its runner and incarnation, and its run where given): the runner
 *  that holds it, once its hold ended. `note` is kept on the row (why the run let it go); none: the row goes. False when
 *  the route is not mine (another's, or none). */
export async function dropRoute(settings: Pick<RouteSettings, "get" | "putIfAbsent" | "replaceIf" | "removeIf">, id: string, mine: { readonly runner: string; readonly incarnation: string; readonly run?: string }, note?: string): Promise<boolean> {
  for (let tried = 0; tried < ROUTE_TRIES; tried++) {
    const { seen, route } = await seeRoute(settings, id);
    if (route.runner !== mine.runner || route.incarnation !== mine.incarnation || (mine.run !== undefined && route.run !== mine.run)) return false;
    if (await replaceRoute(settings, id, seen, { ...EMPTY_ROUTE, refused: note ?? null })) return true;
  }
  return false;
}
