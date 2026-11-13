// The run's one booking. A run's model requests are booked per session (modelPortFor: each CLI session key, and pi's own
// once it is an adapter), but a cap is the run's: a session is judged on what every session of the run has spent and
// holds, never on its own alone. runBooking wraps the host's beforeRequest (the cap's beforeRequestOf) so that each
// request it is asked about carries the run's totals:
// - `spentUsd`: every session's spend from its runner records (sessionSpendOf), summed; a request recorded and not yet
//   answered (in flight in any session, in this process or a lost one) counts there at what its host held for it;
// - `inFlight`: the requests this booking admitted that no record shows yet, each at what it was held at, so two
//   sessions asking at once never both take room only one of them fits.
// Admissions run one at a time across the run's sessions. The priced tools' charges and holds are not here: they are the
// host's spentUsd and heldUsd hooks (beforeRequestOf), read beside these.
import { type BeforeRequest, type InFlight, sessionSpendOf } from "./runner.js";
import type { SessionRecord } from "./types.js";

/** The run's sessions: every key it has, and each one's records. */
export interface RunSessions {
  keys(): readonly string[] | Promise<readonly string[]>;
  read(key: string): Promise<SessionRecord[]>;
}

const idOf = (key: string, turn: number) => `${key}\u0000${turn}`;

/** `before`, asked about each request with the run's totals over `sessions` in place of its session's own. */
export function runBooking(sessions: RunSessions, before: BeforeRequest): BeforeRequest {
  /** Admitted here and not yet recorded, by session and turn. One whose record never lands (its write refused, its
   *  process gone) stays held: the run's spend is never under-counted. */
  const admitted = new Map<string, InFlight>();
  let queue: Promise<unknown> = Promise.resolve();
  return (request) => {
    const asked = queue.then(async () => {
      let spentUsd: number | null = 0;
      const recorded = new Set<string>();
      for (const key of await sessions.keys()) {
        const spend = sessionSpendOf(await sessions.read(key));
        spentUsd = spentUsd === null || spend.spentUsd === null ? null : spentUsd + spend.spentUsd;
        // A hold-only step still open is no spend in its records: this booking keeps counting the one it admitted, in
        // flight at its hold, until it is answered (a lost claim's, admitted by no booking here, counts nothing).
        for (const turn of spend.turns) if (!spend.openHolds.has(turn)) recorded.add(idOf(key, turn));
      }
      for (const id of [...admitted.keys()]) if (recorded.has(id)) admitted.delete(id);
      const verdict = await before({ ...request, spentUsd, inFlight: [...admitted.values()] });
      if (!(verdict && "refuse" in verdict)) {
        const holdUsd = verdict && "holdUsd" in verdict ? verdict.holdUsd : undefined;
        const outputTokensMax = verdict && "outputTokensMax" in verdict ? verdict.outputTokensMax : request.outputTokensAsked;
        admitted.set(idOf(request.key, request.turn), {
          turn: request.turn,
          model: request.model,
          ...(request.inputTokensMax === undefined ? {} : { inputTokensMax: request.inputTokensMax }),
          ...(outputTokensMax === undefined ? {} : { outputTokensMax }),
          ...(typeof holdUsd === "number" ? { holdUsd } : {}),
          ...(request.host === undefined ? {} : { host: request.host }),
        });
      }
      return verdict;
    });
    queue = asked.catch(() => undefined);
    return asked;
  };
}
