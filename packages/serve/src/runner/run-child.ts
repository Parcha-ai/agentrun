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
import { setHeld, type Held } from "./held.js";
import { createDispatchLoop } from "./dispatch.js";
import { resolveRunnerLoop } from "./harness-loops.js";
import { type Claim, type Command, type HeldState, type Journal, type Loop, type LoopDeps, recoveriesDone, type StopReason } from "./loop-contract.js";
import { heldRedactor, processSecretRedactor } from "./redact.js";
import { Channel } from "./run-channel.js";
import { childDeps, type ChildInit } from "./run-child-deps.js";
import { registerRunErrors } from "./run-errors.js";
import { carriedLedger } from "../paid-calls.js";
import { reportHoldsTo } from "../web-holds.js";
import type { JournalReads, Store } from "../store/store.js";

/** How often the run's process reads its loop's held state (LoopDeps.live) and posts it to its runner when it moved: the
 *  runner's live ticker reads the newest it was posted. */
const LIVE_POLL_MS = 200;

registerRunErrors();

const socket = new Socket({ fd: 4, readable: true, writable: true });
const channel = new Channel(socket, {
  // The runner closed the channel (the loop's end answered) or is gone: nothing of the run's goes on but a lost create's
  // recovery under way here (its browser released, to its own bound and the release's margin: recoveriesDone), then the
  // process exits. Its trace is the runner's to send (postedTracing): nothing here waits on a collector.
  onClose: () => void recoveriesDone(Date.now(), 0, Infinity, releaseMarginMs).finally(() => setImmediate(() => process.exit(0))),
  // Each call carries the ledger of the tool call it is made in: what the runner does for it (an MCP tool's call, a
  // computer's) books on the run's one ledger, as it would in the run's own process.
  context: carriedLedger,
});
// A keyless hold the run meets is the server's (web-holds.ts): handed to the runner, whose server keeps it. An end JSON
// cannot carry (none named) goes as null.
reportHoldsTo((hold) => channel.post("runner", "webHold", [{ ...hold, until: Number.isFinite(hold.until) ? hold.until : null }]));

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

let loop: Loop | undefined;
/** When the runner's close cuts the claim's tool hosts' release (LoopDeps.releaseBy), as its stop or closing said. */
let releaseBy: number | undefined;
/** The runner's margin on the release (LoopDeps.releaseMarginMs), once its start said one: a recovery's at the close too. */
let releaseMarginMs: number | undefined;
let made!: (loop: Loop) => void;
const loopMade = new Promise<Loop>((resolve) => (made = resolve));

/** The loop target the runner calls: the claim's start, then its commands and its stop. */
channel.expose("loop", async (method, args) => {
  switch (method) {
    case "start": {
      if (loop) throw new Error("the run's process runs one claim");
      const init = args[0] as ChildInit;
      releaseMarginMs = init.releaseMarginMs;
      const held = channel.remote<Held>("held");
      setHeld(held);
      // Store.readJournal answers at once (a reader, its reads asynchronous): the process's own reader, each read one call.
      const readJournal = (runId: string) => readerOf(runId, (read, args) => channel.call("store", "readJournal", [runId, read, args]));
      const store = channel.remote<Store>("store", { where: init.where, readJournal });
      const journal = remoteJournal(init.claim);
      const deps = childDeps(init, store, journal, held, channel);
      let read: (() => HeldState | undefined) | undefined;
      const loopDeps: LoopDeps = {
        journal: () => journal,
        flush: () => channel.call("runner", "flush", []) as Promise<void>,
        signal: init.signal,
        ...(init.pastDeadline ? { pastDeadline: init.pastDeadline } : {}),
        delivered: (channel.call("runner", "delivered", []) as Promise<void>).catch(() => undefined),
        deliverNow: () => channel.call("runner", "deliverNow", []) as Promise<void>,
        // A row this process's dispatch took for now and its loop then refused: written refused by the runner, under its claim.
        refuse: (commandId, reason) => channel.call("runner", "refuse", [commandId, reason]) as Promise<void>,
        live: (reader) => void (read = reader),
        redact: heldRedactor(processSecretRedactor()),
        ...(init.releaseBoundMs === undefined ? {} : { releaseBoundMs: init.releaseBoundMs }),
        ...(init.releaseMarginMs === undefined ? {} : { releaseMarginMs: init.releaseMarginMs }),
        releaseBy: () => releaseBy,
      };
      // Its runner counted the harness's key rows before it made this process (staysInRunner): never again here.
      loop = createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: resolveRunnerLoop(deps, { keysCounted: true }) })(loopDeps);
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
      // A shutdown's stop carries when the runner's close cuts the release (run-child-host.ts): the same clock, one host.
      if (typeof args[1] === "number") releaseBy = args[1];
      return (await loopMade).stop(args[0] as StopReason);
    case "closing":
      // The close's cut of the release, for a loop already stopping (run-child-host.ts closing).
      if (typeof args[0] === "number") releaseBy = args[0];
      return (await loopMade).closing?.();
    default:
      throw new Error(`a run's loop has no ${method}`);
  }
});
