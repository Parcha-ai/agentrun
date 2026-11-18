// A run's own process (run-child-host.ts starts it, one per claim): `node --import dist/secrets.js dist/runner/run-child.js`,
// as its slot's uid where the image's helper can switch. secrets.js has read the run's own keys from descriptor 3 and
// closed it before this module loads; descriptor 4 is the channel to its runner (run-channel.ts).
//
// It runs the claim's loop as the runner would have in its own process (the dispatch, the run's harness loop), with what
// the runner holds asked over the channel: the run's journal (the runner's, behind its fence), the store's reads of the
// claim (bound to it by the runner), and what the seal key opens for the claim (held.ts). It holds no seal key, no store
// connection and no other run's anything. It ends when its loop ended and the runner closed the channel, or at once when
// the channel closes under it (its runner gone).
import { Socket } from "node:net";
import { readBackOf } from "@parcha/agentrun-computer";
import { heldInstall, type HeldComputerAsk, setHeld, type Held } from "./held.js";
import { createDispatchLoop } from "./dispatch.js";
import { resolveRunnerLoop } from "./harness-loops.js";
import { type Claim, type Command, type HeldState, type Journal, type Loop, type LoopDeps, type StopReason } from "./loop-contract.js";
import { routeOf } from "./model-route.js";
import { heldRedactor, processSecretRedactor } from "./redact.js";
import { Channel } from "./run-channel.js";
import { registerRunErrors } from "./run-errors.js";
import { runEnv } from "./main.js";
import { carriedLedger } from "../paid-calls.js";
import { heldHands, type ComputerHold, type HoldAsk, type HoldEvent, type HoldState } from "../workspace/computer-hold.js";
import type { ClaimComputer } from "../workspace/computer-for-claim.js";
import type { AdapterSpecDeps } from "./adapter-run-spec.js";
import type { JournalReads, Store } from "../store/store.js";

/** How often the run's process reads its loop's held state (LoopDeps.live) and posts it to its runner when it moved: the
 *  runner's live ticker reads the newest it was posted. */
const LIVE_POLL_MS = 200;

/** What the runner hands the run's process at the start (run-child-host.ts): the claim, the data directory, the claim's
 *  abort and the options of the runner's own deps. */
interface ChildInit {
  readonly claim: Claim;
  readonly data: string;
  readonly signal: AbortSignal;
  readonly where?: unknown;
  readonly mcpLoopback?: true;
  readonly mcpOwn?: readonly string[];
  readonly githubApi?: string;
  readonly githubWeb?: string;
  readonly githubMcpOrigin?: string;
}

registerRunErrors();

const socket = new Socket({ fd: 4, readable: true, writable: true });
const channel = new Channel(socket, {
  // The runner closed the channel (the loop's end answered) or is gone: nothing of the run's goes on.
  onClose: () => void setImmediate(() => process.exit(0)),
  // Each call carries the ledger of the tool call it is made in: what the runner does for it (an MCP tool's call, a
  // computer's) books on the run's one ledger, as it would in the run's own process.
  context: carriedLedger,
});

/** A journal's reads for run `runId`, each `call(read, args)` to the runner with the arguments the caller gave but its
 *  context (the runner reads with its own: run-child-host.ts readOf). */
function readerOf(runId: string, call: (read: string, args: unknown[]) => Promise<unknown>): JournalReads {
  const read = (method: string, ...args: unknown[]) => call(method, args) as Promise<never>;
  return {
    runId,
    conversation: (id) => read("conversation", id),
    scanConversations: (query, limit, cursor) => read("scanConversations", query, limit, cursor),
    entry: ((...args: unknown[]) => (args.length >= 3 ? read("entry", args[0], args[1]) : read("entry", args[0]))) as JournalReads["entry"],
    findLatestHeadMarker: (conversation, at) => read("findLatestHeadMarker", conversation, at),
    scanEntries: (query, limit, cursor) => read("scanEntries", query, limit, cursor),
    task: (id) => read("task", id),
    scanTasks: (query, limit, cursor) => read("scanTasks", query, limit, cursor),
    submission: (id) => read("submission", id),
    scanSubmissions: (query, limit, cursor) => read("scanSubmissions", query, limit, cursor),
    submissionByRequest: (conversation, request) => read("submissionByRequest", conversation, request),
    findDocument: (address, at) => read("findDocument", address, at),
    document: ((address: unknown, at: unknown) => read("document", address, at)) as JournalReads["document"],
    scanDocuments: ((query: unknown, limit: unknown, cursor: unknown) => read("scanDocuments", query, limit, cursor)) as JournalReads["scanDocuments"],
    commitsAfter: (after, limit) => read("commitsAfter", after, limit),
    close: async () => {},
  };
}

/** The run's journal, the runner's of the claim: every write and read made there, under its fence. */
function remoteJournal(claim: Claim): Journal {
  return {
    ...readerOf(claim.runId, (read, args) => channel.call("journal", read, args)),
    async commit(batches, receive) {
      const { result, seqs } = (await channel.call("journal", "commit", [batches])) as { result: Awaited<ReturnType<Journal["commit"]>>; seqs: [number, never][] };
      for (const [index, seq] of seqs) receive(index, seq);
      return result;
    },
    publishing: (publish) => publish(),
    // Posted, in order before the commit it rides with; a refusal of it fails that commit (run-child-host.ts).
    stage: (staged) => channel.post("journal", "stage", [staged]),
    mintId: () => channel.call("journal", "mintId", []) as Promise<never>,
  } as Journal;
}

/** The person's hold on the claim's computer (computer-hold.ts), as the run's loop reads it here: the runner's hold, where
 *  the live viewer takes and gives it, mirrored. What the loop reads at once (who drives, the take, the epoch, the open
 *  ask, whether the run is ending) is the runner's as its last change left it; each change the runner's hold makes comes
 *  here as its event, the mirror read again before this process's listeners hear it. A take, a hand-back or an answer
 *  the loop makes is the runner's to apply, answered here as the runner's hold answers it from the same state. */
async function mirroredHold(remote: ComputerHold): Promise<ComputerHold> {
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
 *  runs at once (the computer package's read-back, by its epoch) and the person's hold over the computer's port (the
 *  runner's hold, mirrored: mirroredHold). */
async function computerHere(got: ClaimComputer): Promise<ClaimComputer> {
  const made = got as ClaimComputer & { computer?: { check?: { epoch?: number } } };
  const check = made.computer?.check;
  const computer = made.computer && check ? { ...made.computer, check: { readBackOf, ...(check.epoch !== undefined ? { epoch: check.epoch } : {}) } } : made.computer;
  const hold = got.held ? await mirroredHold(got.held.hold) : undefined;
  return {
    ...got,
    ...(computer ? { computer: computer as ClaimComputer["computer"] } : {}),
    ...(got.held && hold ? { held: { kind: got.held.kind, hold }, hold: (ports: Parameters<NonNullable<ClaimComputer["hold"]>>[0]) => heldHands(ports as never, hold) } : {}),
  } as ClaimComputer;
}

/** The deps the run's loop runs with in this process: the runner's, with each thing it holds asked over the channel. */
function childDeps(init: ChildInit, store: Store, journal: Journal, held: Held): AdapterSpecDeps {
  const computerForClaim = (async (_launch: unknown, _store: unknown, given: Record<string, unknown>) => {
    const recordings = given.recordings as { say?: (words: string) => void } | undefined;
    const ask: HeldComputerAsk = {
      hadComputer: given.hadComputer as () => Promise<boolean>,
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
    ...(init.githubApi ? { githubApi: init.githubApi } : {}),
    ...(init.githubWeb ? { githubWeb: init.githubWeb } : {}),
    ...(init.githubMcpOrigin ? { githubMcpOrigin: init.githubMcpOrigin } : {}),
    ...(init.mcpLoopback ? { mcpLoopback: true, mcpOwn: init.mcpOwn ?? [] } : {}),
  };
}

let loop: Loop | undefined;
let made!: (loop: Loop) => void;
const loopMade = new Promise<Loop>((resolve) => (made = resolve));

/** The loop target the runner calls: the claim's start, then its commands and its stop. */
channel.expose("loop", async (method, args) => {
  switch (method) {
    case "start": {
      if (loop) throw new Error("the run's process runs one claim");
      const init = args[0] as ChildInit;
      const held = channel.remote<Held>("held");
      setHeld(held);
      // Store.readJournal answers at once (a reader, its reads asynchronous): the process's own reader, each read one call.
      const readJournal = (runId: string) => readerOf(runId, (read, args) => channel.call("store", "readJournal", [runId, read, args]));
      const store = channel.remote<Store>("store", { where: init.where, readJournal });
      const journal = remoteJournal(init.claim);
      const deps = childDeps(init, store, journal, held);
      let read: (() => HeldState | undefined) | undefined;
      const loopDeps: LoopDeps = {
        journal: () => journal,
        flush: () => channel.call("runner", "flush", []) as Promise<void>,
        signal: init.signal,
        delivered: (channel.call("runner", "delivered", []) as Promise<void>).catch(() => undefined),
        deliverNow: () => channel.call("runner", "deliverNow", []) as Promise<void>,
        live: (reader) => void (read = reader),
        redact: heldRedactor(processSecretRedactor()),
      };
      loop = createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: resolveRunnerLoop(deps) })(loopDeps);
      made(loop);
      // The loop's held state and whether a plain stop keeps its computer, posted when either moved.
      let last = "";
      const poll = setInterval(() => {
        let state: HeldState | undefined;
        try {
          state = read?.();
        } catch {
          state = undefined;
        }
        const keeps = loop?.keepsComputer?.({ kind: "command", commandId: 0 }) === true;
        let said: string;
        try {
          said = JSON.stringify([state ?? null, keeps]);
        } catch {
          return;
        }
        if (said === last) return;
        last = said;
        channel.post("runner", "live", [state, keeps]);
      }, LIVE_POLL_MS);
      try {
        return await loop.start(init.claim);
      } finally {
        clearInterval(poll);
      }
    }
    case "command":
      return (await loopMade).command(args[0] as Command);
    case "stop":
      return (await loopMade).stop(args[0] as StopReason);
    default:
      throw new Error(`a run's loop has no ${method}`);
  }
});
