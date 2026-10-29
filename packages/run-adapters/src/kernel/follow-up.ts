// A follow-up: once a session has answered, one more turn in the same session, with a prompt the host names. It is one
// `never` effect on a key of its own (a drive on the session's own key would fence the session's writer): its intent is
// durable before the prompt leaves, so a process that dies inside it leaves it interrupted, and no later process sends
// the prompt again. A follow-up turn a crash cut off is settled, never resumed: resuming it would make paid requests
// for a turn that is over. Its paid requests are held to a reserve of their own, counted from its first request.
import type { SessionState as AdapterSessionState, SessionStore, TurnStatus } from "../types.js";
import { foldSession, openDrive } from "./drive.js";
import { EffectFailure, EffectInterrupted } from "./errors.js";

/** The effect's key in the follow-up's own session. */
export const FOLLOW_UP_EFFECT = "follow-up";
/** What a request the reserve refuses says, first. */
export const FOLLOW_UP_BUDGET_REACHED = "follow_up_budget_reached";

/** The follow-up's own session key, beside the session it follows up. */
export const followUpKey = (session: string, name: string): string => `${session}:follow-up:${name}`;

/** The session as a follow-up drives it: an adapter's session, and how a turn a crash cut off is closed unsent. */
export interface FollowUpTarget {
  readonly state: AdapterSessionState;
  send(text: string): Promise<void>;
  turnEnd(): Promise<{ status: TurnStatus; error?: string }>;
  /** Record the open turn as ended, interrupted, and send nothing. */
  settleOpenTurn(): Promise<void>;
}

export interface FollowUpOptions {
  store: SessionStore;
  /** The key of the session it follows up. */
  session: string;
  /** The follow-up's name: one follow-up per name per session. */
  name: string;
  prompt: string;
  /** The most its paid requests may cost, in dollars, counted from its first request. */
  reserveUsd: number;
  /** A request's worst case, held for each request in flight and the one asked for (default 0: refused once spent). */
  worstUsd?: number;
}

export type FollowUpResult = { status: "done" } | { status: "interrupted" } | { status: "failed"; error: string };

export interface FollowUp {
  readonly key: string;
  /** Ahead of the host's own check on each paid request: undefined outside the follow-up's turn. */
  beforeRequest(request: { spentUsd: number | null; inFlight: readonly unknown[] }): undefined | { refuse: string };
  /** Sends the follow-up once, or answers from its record. */
  run(target: FollowUpTarget, signal: AbortSignal): Promise<FollowUpResult>;
}

export type FollowUpState = "none" | "running" | "done" | "interrupted" | "failed";

/** The follow-up's state in its records, as written: `running` is one a process that died left without an outcome. A
 *  host reads it before it resumes an open turn: a turn of a `running` or `interrupted` follow-up is settled instead. */
export function followUpState(records: Parameters<typeof foldSession>[1]): FollowUpState {
  const effect = foldSession("", records).effects.get(FOLLOW_UP_EFFECT);
  if (!effect) return "none";
  if (effect.status === "completed") return "done";
  if (effect.status === "failed") return effect.error?.interrupted ? "interrupted" : "failed";
  return "running";
}

export function followUpOnce(options: FollowUpOptions): FollowUp {
  const { store, prompt, reserveUsd } = options;
  const worstUsd = options.worstUsd ?? 0;
  if (typeof reserveUsd !== "number" || !Number.isFinite(reserveUsd) || reserveUsd <= 0) throw new Error("reserveUsd must be a number of dollars above 0");
  if (typeof worstUsd !== "number" || !Number.isFinite(worstUsd) || worstUsd < 0) throw new Error("worstUsd must be a number of dollars, 0 or more");
  const key = followUpKey(options.session, options.name);
  let active = false;
  // What the session had spent when the follow-up's first request asked: the reserve counts from there.
  let start: number | undefined;
  const refuse = (why: string) => ({ refuse: `${FOLLOW_UP_BUDGET_REACHED}: ${why}` });

  return {
    key,
    beforeRequest({ spentUsd, inFlight }) {
      if (!active) return undefined;
      if (spentUsd === null) return refuse("what the session has spent is unknown, so the follow-up's reserve cannot be kept; the request was not sent");
      start ??= spentUsd;
      const used = spentUsd - start;
      if (used + worstUsd * (inFlight.length + 1) > reserveUsd) return refuse(`$${used.toFixed(6)} spent of a $${reserveUsd} reserve, and the next request could cost up to $${worstUsd}; the request was not sent`);
      return undefined;
    },
    async run(target, signal) {
      const drive = await openDrive({ writer: await store.open(key), signal });
      const known = drive.state().effects.get(FOLLOW_UP_EFFECT);
      if (known?.status === "completed") return { status: "done" };
      if (known?.status === "failed") {
        if (!known.error?.interrupted) return { status: "failed", error: known.error?.message ?? "failed" };
        // Its turn may still be open in the session: closed unsent, never resumed.
        if (target.state === "open_turn") await target.settleOpenTurn();
        return { status: "interrupted" };
      }
      if (target.state === "open_turn") throw new Error("the session has an open turn that is not this follow-up's: recover it before the follow-up");
      try {
        await drive.effect(FOLLOW_UP_EFFECT, { name: options.name, replay: "never", input: { prompt } }, async () => {
          active = true;
          try {
            await target.send(prompt);
            const end = await target.turnEnd();
            if (end.status === "interrupted") throw new EffectInterrupted(end.error ?? "the follow-up's turn was interrupted");
            if (end.status !== "completed") throw new Error(end.error ?? "the follow-up's turn failed");
            return null;
          } finally {
            active = false;
          }
        });
        return { status: "done" };
      } catch (error) {
        if (error instanceof EffectFailure) return error.error.interrupted ? { status: "interrupted" } : { status: "failed", error: error.error.message };
        throw error;
      }
    },
  };
}
