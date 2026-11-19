// Each runner's word that it is there (store `runners`), and what the server makes of them: whether any runner here can take
// a run. A runner that claims keeps a row with no refusal for as long as it runs (startRunner); a runner whose run isolation
// was refused (run-child-host.ts runIsolationOf) keeps one with its words, beside a server (cli.ts, through Serve.refuseRuns)
// or in a process of its own (runner/main.ts), so a server in another process, or on another host over one Postgres, reads
// it. A runner in a process of its own with a relay (dial-relay.ts) says on the same row where its relay answers, under the
// same incarnation (runner/main.ts makes one per process), so the server relays a dial only to a runner this row says is
// there. Each row is renewed every PRESENCE_RENEW_MS and read as gone once it is PRESENCE_STALE_MS old: a runner that died
// without its close stops counting within that. While every runner still there refused, and one at least is, the server
// refuses a launch in their words (runs-over-store.ts prepareLaunch), says so in capabilities and health, and fails the
// runs still queued (server.ts). With no runner there at all (a server with --no-runner and its runner not started yet),
// it refuses nothing: runs queue for the runner to come, as before.
import { randomUUID } from "node:crypto";
import type { Runners } from "../store/store.js";

/** How often a runner says again that it is there. */
export const PRESENCE_RENEW_MS = 10_000;
/** How old a runner's word can be and still count: three renewals missed. */
export const PRESENCE_STALE_MS = 3 * PRESENCE_RENEW_MS;

/** Where a runner's relay takes the dials the server relays to it (dial-relay.ts). */
export interface RelayAt {
  readonly host: string;
  readonly port: number;
}

/** A runner's word kept in the store until its close. */
export interface Presence {
  /** The runner's process since its start, on its row: its relay's minted tokens and proofs name the same one. */
  readonly incarnation: string;
  /** Says on its row where its relay answers (`at`), or that it answers nowhere (null, the relay's close), and keeps that
   *  through every put again. Rejects when that write fails, which the renewals then try again. */
  relay(at: RelayAt | null): Promise<void>;
  /** Stops renewing it and removes the row (its incarnation's alone). */
  close(): Promise<void>;
  /** Stops renewing it and leaves the row to go stale, as a crash would. */
  stop(): void;
}

/** Keeps `runner`'s row in `runners` (refused: its words, or null for a runner that claims), renewed every `renewMs`; put
 *  again when it went (a row pruned, a store restored), never over a later process's of the same name. A write that
 *  fails is tried again at the next renewal: it never stops the runner, and `warn` hears it once. `incarnation` is the
 *  runner process's one (runner/main.ts hands its relay the same), a new one by default. */
export function keepPresence(runners: Runners, runner: string, refused: string | null, { renewMs = PRESENCE_RENEW_MS, warn = (_line: string) => {}, incarnation = randomUUID() }: { renewMs?: number; warn?: (line: string) => void; incarnation?: string } = {}): Presence {
  let warned = false;
  const failed = (error: unknown) => {
    if (warned) return;
    warned = true;
    warn(`could not say in the store that runner ${runner} is there: ${error instanceof Error ? error.message : String(error)}`);
  };
  let at: RelayAt | null = null;
  const put = () => runners.put({ runner, incarnation, refused, host: at?.host ?? null, port: at?.port ?? null });
  let writing: Promise<unknown> = put().catch(failed);
  const timer = setInterval(() => {
    writing = writing.then(async () => {
      // Put again only when its row went: one a later process of the same name put is that process's, never taken back.
      if (!(await runners.seen(runner, incarnation)) && !(await runners.list()).some((row) => row.runner === runner)) await put();
    }).catch(failed);
  }, renewMs);
  timer.unref();
  let stopped = false;
  return {
    incarnation,
    relay(next) {
      at = next;
      // Once closed or stopped it writes nothing more: a relay's close after its presence's never puts the row back.
      if (stopped) return Promise.resolve();
      // After any write in flight, so a renewal's put never lands over it with the place before.
      const wrote = writing.then(put);
      writing = wrote.catch(failed);
      return wrote;
    },
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await writing;
      await runners.remove(runner, incarnation).catch(() => undefined);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** Why no runner here can take a run, in the runners' own words, or undefined while one can (or none is there): the rows
 *  seen within `staleMs` on the store's clock (Runners.live), when there is one at least and every one refused. */
export async function runnersRefused(runners: Pick<Runners, "live">, staleMs = PRESENCE_STALE_MS): Promise<string | undefined> {
  const live = await runners.live(staleMs);
  if (live.length === 0 || live.some((row) => row.refused === null)) return undefined;
  const reasons = [...new Set(live.map((row) => row.refused as string))];
  return `No runner of this server can take a run: ${reasons.join(" ")}`;
}

/** The code a run fails with when no runner here could take it (its error's code, and a launch's refusal's). */
export const RUNNER_REFUSED_CODE = "runner_refused";
const REFUSED_END = `${RUNNER_REFUSED_CODE}: `;
/** The summary of a queued run failed because no runner here can take it (Runs.failUnclaimed): the code, then `words`. */
export const refusedEnd = (words: string): string => `${REFUSED_END}${words}`;
/** The words of a summary refusedEnd wrote, or undefined for any other (store-view.ts errorOfRow). */
export const refusedEndMessage = (summary: string | null | undefined): string | undefined =>
  typeof summary === "string" && summary.startsWith(REFUSED_END) ? summary.slice(REFUSED_END.length) : undefined;
