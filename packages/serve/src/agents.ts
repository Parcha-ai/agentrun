// How a request waits out a busy store: SQLite's busy or locked, or the agent home's own `busy`, retried step by step
// (whenFree), then answered home_busy. The agents themselves are over the one store (agents-store.ts).
import { AgentHomeError } from "@parcha/pi-durable-agent";
import { ApiError } from "./errors.js";
import { isObject } from "./validate.js";

/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the database. */
export const sqliteBusy = (error: unknown) => isObject(error) && error.code === "ERR_SQLITE_ERROR" && typeof error.errcode === "number" && [5, 6].includes(error.errcode & 0xff);

/** How long a request waits for a busy agent store, step by step: short first, so a reader's overlap costs
 *  milliseconds; about 2 s in all, then the request answers home_busy. */
export const REQUEST_BUSY_MS: readonly number[] = [10, 20, 50, 100, 200, 400, 600, 600];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `act` again while another connection holds the store: after busy `attempt`, `onBusy` hears of it and the next of
 *  `delaysMs` is waited out without blocking the event loop. Past the last, the busy error is thrown. */
export async function whenFree<T>(act: () => T | Promise<T>, delaysMs: readonly number[], onBusy?: (attempt: number, delayMs: number | undefined) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await act();
    } catch (error) {
      if (!sqliteBusy(error)) throw error;
      const delay = delaysMs[attempt];
      onBusy?.(attempt, delay);
      if (delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

/** A store another writer holds: SQLite's busy or locked, or the agent home's own `busy` (a home held past its deadline, or a
 *  store a stopped writer left mid-write). Every answer of the server maps it the same way: home_busy. */
export const storeBusy = (error: unknown) => sqliteBusy(error) || (error instanceof AgentHomeError && error.code === "busy");

/** The answer to a request the agent store stayed busy for. */
export const homeBusy = () => new ApiError("home_busy", "the agent store is busy with another write; try again", { retry_after_ms: 500 });
