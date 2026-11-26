// The deps a run's own process (run-child.ts) runs its loop with: the runner's, each thing it holds asked over the
// channel, and the options the runner handed in its start (ChildInit), the plane it capped among them. Apart from
// run-child.ts, whose module opens the process's pipes, so a test reads what a start's init becomes.
import { readBackOf } from "@parcha/agentrun-computer";
import { heldInstall, type HeldComputerAsk, type Held } from "./held.js";
import type { Claim, Journal } from "./loop-contract.js";
import { routeOf } from "./model-route.js";
import type { Channel } from "./run-channel.js";
import { remoteSaveSlots } from "./save-slots.js";
import { runEnv } from "./main.js";
import { heldHands, type ComputerHold, type HoldAsk, type HoldEvent, type HoldState } from "../workspace/computer-hold.js";
import type { ClaimComputer } from "../workspace/computer-for-claim.js";
import type { AdapterSpecDeps } from "./adapter-run-spec.js";
import type { Store } from "../store/store.js";
import { postedTracing } from "../otel/tracer.js";

/** What the runner hands the run's process at the start (run-child-host.ts): the claim, the data directory, the claim's
 *  abort and the options of the runner's own deps. */
export interface ChildInit {
  readonly claim: Claim;
  readonly data: string;
  readonly signal: AbortSignal;
  /** A learning child's deadline (LoopDeps.pastDeadline), aborted by its runner. */
  readonly pastDeadline?: AbortSignal;
  readonly where?: unknown;
  readonly mcpLoopback?: true;
  readonly mcpOwn?: readonly string[];
  readonly githubApi?: string;
  readonly githubWeb?: string;
  readonly githubMcpOrigin?: string;
  readonly composioMcpOrigin?: string;
  /** The runner traces its runs: this run's trace is posted to it (tracer.ts postedTracing). */
  readonly traced?: true;
  /** The plane the runner capped and chose this process's keys by (run-child-host.ts): the claim's, as it is. */
  readonly plane?: AdapterSpecDeps["claimedPlane"];
}

/** The person's hold on the claim's computer (computer-hold.ts), as the run's loop reads it here: the runner's hold, where
 *  the live viewer takes and gives it, mirrored. What the loop reads at once (who drives, the take, the epoch, the open
 *  ask, whether the run is ending) is the runner's as its last change left it; each change the runner's hold makes comes
 *  here as its event, the mirror read again before this process's listeners hear it. A take, a hand-back or an answer
 *  the loop makes is the runner's to apply, answered here as the runner's hold answers it from the same state. */
export async function mirroredHold(remote: ComputerHold): Promise<ComputerHold> {
  type Seen = { state: HoldState; current: string | undefined; epoch: number; asked: HoldAsk | undefined; finishing: boolean };
  const read = async (): Promise<Seen> => {
    const [state, current, epoch, asked, finishing] = await Promise.all([remote.state(), remote.current(), remote.epoch(), remote.asked(), remote.finishing()]);
    return { state, current, epoch, asked, finishing };
  };
  let seen = await read();
  const listeners = new Set<(event: HoldEvent) => void>();
  let heard: Promise<void> = Promise.resolve();
  await remote.on((event) => {
    heard = heard.then(async () => {
      seen = await read().catch(() => seen);
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // A listener's error is not the hold's.
        }
      }
    });
  });
  const forward = (made: unknown): void => void Promise.resolve(made).catch(() => undefined);
  return {
    state: () => seen.state,
    current: () => seen.current,
    epoch: () => seen.epoch,
    asked: () => seen.asked,
    finishing: () => seen.finishing,
    take(options) {
      if (seen.finishing || seen.state !== "agent") return false;
      seen = { ...seen, state: "pending", current: options?.by !== undefined ? `c${options.by}` : seen.current, epoch: seen.epoch + 1 };
      forward(remote.take(options));
      return true;
    },
    finish() {
      seen = { ...seen, finishing: true };
      forward(remote.finish());
    },
    give(why, options) {
      if (seen.state === "agent") return false;
      seen = { ...seen, state: "agent", current: undefined, epoch: seen.epoch + 1 };
      forward(remote.give(why, options));
      return true;
    },
    away: () => forward(remote.away()),
    touched: () => forward(remote.touched()),
    ask: (request, signal) => remote.ask(request, signal),
    answer(id, outcome, options) {
      if (seen.asked?.id !== id) return false;
      seen = { ...seen, asked: undefined, ...(seen.state !== "agent" ? { state: "agent" as const, current: undefined, epoch: seen.epoch + 1 } : {}) };
      forward(remote.answer(id, outcome, options));
      return true;
    },
    enter: (signal) => remote.enter(signal),
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => forward(remote.close()),
  };
}

/** The claim's computer as the runner made it (Held.computer), with what must run here put back: the mount check attach
 *  runs at once (the computer package's read-back, by its epoch, of a synced folder where it is one) and the person's hold over the computer's port (the
 *  runner's hold, mirrored: mirroredHold). */
export async function computerHere(got: ClaimComputer): Promise<ClaimComputer> {
  const made = got as ClaimComputer & { computer?: { check?: { epoch?: number; sync?: true } } };
  const check = made.computer?.check;
  const computer = made.computer && check ? { ...made.computer, check: { readBackOf, ...(check.epoch !== undefined ? { epoch: check.epoch } : {}), ...(check.sync ? { sync: true as const } : {}) } } : made.computer;
  const hold = got.held ? await mirroredHold(got.held.hold) : undefined;
  return {
    ...got,
    ...(computer ? { computer: computer as ClaimComputer["computer"] } : {}),
    ...(got.held && hold ? { held: { kind: got.held.kind, hold }, hold: (ports: Parameters<NonNullable<ClaimComputer["hold"]>>[0]) => heldHands(ports as never, hold) } : {}),
  } as ClaimComputer;
}

/** The deps the run's loop runs with in this process: the runner's, with each thing it holds asked over the channel. */
export function childDeps(init: ChildInit, store: Store, journal: Journal, held: Held, channel: Pick<Channel, "post" | "call">): AdapterSpecDeps {
  const computerForClaim = (async (_launch: unknown, _store: unknown, given: Record<string, unknown>) => {
    const recordings = given.recordings as { say?: (words: string) => void } | undefined;
    const ask: HeldComputerAsk = {
      hadComputer: given.hadComputer as () => Promise<boolean>,
      ...(typeof given.turnedOff === "string" ? { turnedOff: given.turnedOff } : {}),
      ...(given.signal instanceof AbortSignal ? { signal: given.signal } : {}),
      ...(recordings?.say ? { say: recordings.say } : {}),
      ...(typeof given.onImageWait === "function" ? { onImageWait: given.onImageWait as HeldComputerAsk["onImageWait"] } : {}),
      ...(typeof given.onStarting === "function" ? { onStarting: given.onStarting as HeldComputerAsk["onStarting"] } : {}),
      ...(typeof given.onConnected === "function" ? { onConnected: given.onConnected as HeldComputerAsk["onConnected"] } : {}),
      ...(typeof given.onComputerNote === "function" ? { onComputerNote: given.onComputerNote as HeldComputerAsk["onComputerNote"] } : {}),
    };
    return await computerHere((await held.computer(ask)) as ClaimComputer);
  }) as unknown as AdapterSpecDeps["computerForClaim"];
  return {
    env: runEnv(process.env),
    data: init.data,
    journal: () => journal,
    store: store as AdapterSpecDeps["store"],
    sealKey: undefined,
    routeOf,
    log: (line) => channel.post("runner", "log", [line]),
    computerForClaim,
    computerDeps: {} as AdapterSpecDeps["computerDeps"],
    installForClaim: heldInstall as AdapterSpecDeps["installForClaim"],
    // web_save's download slots are the runner's, shared by all its runs (save-slots.ts).
    saveSlots: remoteSaveSlots(channel),
    ...(init.plane ? { claimedPlane: init.plane } : {}),
    ...(init.githubApi ? { githubApi: init.githubApi } : {}),
    ...(init.githubWeb ? { githubWeb: init.githubWeb } : {}),
    ...(init.githubMcpOrigin ? { githubMcpOrigin: init.githubMcpOrigin } : {}),
    ...(init.composioMcpOrigin ? { composioMcpOrigin: init.composioMcpOrigin } : {}),
    ...(init.mcpLoopback ? { mcpLoopback: true, mcpOwn: init.mcpOwn ?? [] } : {}),
    // The run's trace, posted to the runner, which exports it: never one of this process's own (no OTLP setting reaches
    // it, and nothing here flushes).
    tracing: Promise.resolve(init.traced ? postedTracing((method, args) => channel.post("trace", method, args)) : undefined),
  };
}
