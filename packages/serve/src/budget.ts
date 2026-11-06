// A workflow run's pause at its spend cap, both sides of it, as files in the run's directory beside serve.json.
//
// In the run's process: a step its cap refuses for room (a model node's request, a call node's call, a decision) waits
// for a raise where it stands, unsent, and the run waits with it: `budget.json` says at what (the refusal's words and
// figures, and the node), which the server reads as the run's pause (input_required, `pending.kind` budget). A raise
// (PATCH /v2/runs/{id}) keeps the new cap in serve.json, then writes it to `cap.json`, which the waiting process reads:
// its cap moves to it (RunSpend.raise), `budget.json` goes, and each waiting step is judged again. A step waits for a
// raise only where it was never admitted (a model request not yet sent; a call node's call, whose refused effect ended
// as held, and a decision, both outside the durable driver's admission), so a pause that waits BUDGET_HOLD_MS with every
// step in flight waiting lets its process go (its own SIGTERM: released, its run resumable from its journal), and the
// server starts none until a raise does. What a call node's deadline counts never holds the time it waited (held(),
// the interpreter's deps.held).
//
// A refusal no raise fixes (a model or decision with no price, a spend no one knows) is no pause: `cap-stopped.json`
// keeps its words and node, the step throws CapStop, which no collecting map takes for an item's failure, and the server
// ends the run failed with `spend_cap_reached` in those words.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAP_TOLERANCE, type CapRefusal, type RunSpend, SPEND_CAP_REACHED } from "./cap.js";
import { RUN_CANCELLED } from "./files.js";

export const BUDGET_PAUSE = "budget.json";
export const CAP_RAISED = "cap.json";
export const CAP_STOPPED = "cap-stopped.json";
/** How long a workflow run's pause keeps its process before it lets it go (the lead's ruling: 10 minutes). */
export const BUDGET_HOLD_MS = 10 * 60_000;
/** The process's environment variable naming another hold, in ms (the server's `budgetHold` option, for its tests). */
export const BUDGET_HOLD_ENV = "AGENTRUN_SERVE_BUDGET_HOLD_MS";
const POLL_MS = 250;

/** Where a step stands in its workflow: its node's label and execution path. */
export type StepAt = { label: string; path: string | null };
/** What `budget.json` holds: the refusal the run waits at, its figures, and the node. */
export type BudgetMark = { words: string; cap_usd: number; spent_usd?: number; needs_usd?: number; least_cap_usd?: number; bound_usd?: number; node: string | null; path: string | null; at: string };
/** What `cap-stopped.json` holds: the refusal that ended the run, and the node. */
export type CapStopped = { words: string; node: string | null; at: string };

/** A step its cap refused for good: thrown where the step stood, never an item's failure (it is no EffectFailure and
 *  declares no itemFailure), so the workflow fails on it and the server reads `cap-stopped.json`. */
export class CapStop extends Error {
  override readonly name = "CapStop";
  readonly code = SPEND_CAP_REACHED;
  constructor(readonly refusal: CapRefusal, readonly at: StepAt | undefined) {
    super(`${SPEND_CAP_REACHED}: ${at ? `${at.label}: ` : ""}${refusal.words}`);
  }
}

const writeWhole = (file: string, value: unknown) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};
const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

/** The pause the run at `root` stands at, as its process wrote it; undefined when it waits at none. */
export const budgetPausedIn = (root: string): BudgetMark | undefined => {
  const mark = readJson<BudgetMark>(join(root, BUDGET_PAUSE));
  return mark && typeof mark.words === "string" && typeof mark.cap_usd === "number" ? mark : undefined;
};
/** The refusal that ended the run at `root` for good, as its process wrote it; undefined when none did. */
export const capStoppedIn = (root: string): CapStopped | undefined => {
  const stop = readJson<CapStopped>(join(root, CAP_STOPPED));
  return stop && typeof stop.words === "string" ? stop : undefined;
};
/** A raise's cap, for the run's process to read (the server writes it after serve.json keeps it). */
export const writeRaisedCap = (root: string, usd: number): void => writeWhole(join(root, CAP_RAISED), { max_cost_usd: usd });
/** The pause's mark taken away: a raise sent its run on, here when no process waits at it (it was let go). */
export const clearBudgetPause = (root: string): void => rmSync(join(root, BUDGET_PAUSE), { force: true });

/** The raised cap the run at `root` was given, if any. */
const raisedIn = (root: string): number | undefined => {
  const usd = readJson<{ max_cost_usd?: unknown }>(join(root, CAP_RAISED))?.max_cost_usd;
  return typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : undefined;
};

/** The run's waits for a raise, in its process: `spend` is the run's spend (cap.ts), `holdMs` how long a pause keeps the
 *  process, `letGo` what lets it go. `active()` counts the steps in flight (app.ts wraps each node, call and decision
 *  with `step`); a pause lets the process go only when every one of them is waiting. */
export function budgetWaits(root: string, spend: RunSpend, { holdMs = BUDGET_HOLD_MS, letGo }: { holdMs?: number; letGo: () => void }) {
  let waiting = 0;
  let active = 0;
  let since: number | undefined;
  let gone = false;
  /** Each step's held time by its execution path: what ended, and since when it holds now. */
  const held = new Map<string, { total: number; from?: number }>();
  const cancelled = () => existsSync(join(root, RUN_CANCELLED));
  /** The raise, when one moved the cap above `capUsd` (the cap that refused): the spend's cap follows it. */
  const raisedAbove = (capUsd: number): boolean => {
    const raised = raisedIn(root);
    if (raised !== undefined && raised > spend.cap + CAP_TOLERANCE) spend.raise?.(raised);
    return spend.cap > capUsd + CAP_TOLERANCE;
  };
  return {
    /** `fn`, counted as a step in flight while it runs. */
    step<P, R>(fn: (params: P) => Promise<R>): (params: P) => Promise<R> {
      return async (params) => {
        active += 1;
        try {
          return await fn(params);
        } finally {
          active -= 1;
        }
      };
    },
    /** What the step at `path` has waited so far, in ms: the interpreter's deps.held, which its deadline does not count. */
    held(path: string): number {
      const at = held.get(path);
      return at ? at.total + (at.from !== undefined ? Date.now() - at.from : 0) : 0;
    },
    /** Waits for a raise of the cap that refused `refusal`, at `at`: true once the cap is above it (now, or by a raise
     *  that comes), false on a cancel or `signal`. The first wait writes the pause's mark; the last one to end on a raise
     *  takes it away. */
    async wait(refusal: CapRefusal, signal?: AbortSignal, at?: StepAt): Promise<boolean> {
      if (raisedAbove(refusal.capUsd)) return true;
      if (cancelled() || signal?.aborted) return false;
      waiting += 1;
      since ??= Date.now();
      const path = at?.path ?? undefined;
      const mine = path === undefined ? undefined : held.get(path) ?? held.set(path, { total: 0 }).get(path)!;
      if (mine && mine.from === undefined) mine.from = Date.now();
      if (!existsSync(join(root, BUDGET_PAUSE))) {
        const f = refusal.figures;
        writeWhole(join(root, BUDGET_PAUSE), {
          words: refusal.words, cap_usd: refusal.capUsd,
          ...(f ? { spent_usd: f.spentUsd, needs_usd: f.needsUsd, least_cap_usd: f.leastCapUsd, ...(f.boundUsd !== undefined ? { bound_usd: f.boundUsd } : {}) } : {}),
          node: at?.label ?? null, path: at?.path ?? null, at: new Date().toISOString(),
        } satisfies BudgetMark);
      }
      let raised = false;
      try {
        for (;;) {
          if (raisedAbove(refusal.capUsd)) return (raised = true);
          if (cancelled() || signal?.aborted) return false;
          // Held long enough, with nothing in flight but waits: the process goes, and its run with it, resumable.
          if (!gone && since !== undefined && Date.now() - since >= holdMs && active <= waiting) {
            gone = true;
            letGo();
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } finally {
        waiting -= 1;
        if (mine?.from !== undefined) {
          mine.total += Date.now() - mine.from;
          mine.from = undefined;
        }
        if (waiting === 0) {
          since = undefined;
          if (raised) clearBudgetPause(root);
        }
      }
    },
    /** Keeps a refusal no raise fixes, at `at`, for the server: the first one, which the run ends on. */
    record(refusal: CapRefusal, at?: StepAt): void {
      if (!existsSync(join(root, CAP_STOPPED))) writeWhole(join(root, CAP_STOPPED), { words: refusal.words, node: at?.label ?? null, at: new Date().toISOString() } satisfies CapStopped);
    },
    /** Ends the step at `at` on a refusal no raise fixes: its words kept for the server, and CapStop thrown. */
    stop(refusal: CapRefusal, at?: StepAt): never {
      this.record(refusal, at);
      throw new CapStop(refusal, at);
    },
  };
}
export type BudgetWaits = ReturnType<typeof budgetWaits>;
