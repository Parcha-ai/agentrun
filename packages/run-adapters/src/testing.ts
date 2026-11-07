// Test kit: a session store in memory, and a scripted harness with no model and no network. The faux harness keeps its
// own records in the store as a real adapter does (the requests it made, each tool call's intent and outcome, its turns),
// so a later process resumes from them: a request already made is not made again, and a call a crash cut off is
// answered interrupted, never run again.
import { SessionFenced } from "./errors.js";
import { abortedOutcome, SessionHalt } from "./kernel/halt.js";
import type { AdapterSession, AgentAdapter, HostTool, JsonValue, SessionRecord, SessionSpec, SessionState, SessionStore, TurnStatus } from "./types.js";

export { SCHEMA_CHECK_CASES, type SchemaCheckCase } from "./schema-check-cases.js";

/** A session store in memory: what one run's store holds, across the processes a test plays. Each `open` of a key
 *  counts one more holder at once, and a writer appends only while its count is the newest. */
export function memorySessionStore(): SessionStore & { keys(): string[] } {
  const sessions = new Map<string, SessionRecord[]>();
  const holders = new Map<string, number>();
  const read = async (key: string) => structuredClone(sessions.get(key) ?? []);
  return {
    read,
    async open(key) {
      const holder = (holders.get(key) ?? 0) + 1;
      holders.set(key, holder);
      return {
        key,
        read: () => read(key),
        async append(records) {
          if (holders.get(key) !== holder) throw new SessionFenced(key);
          sessions.set(key, [...(sessions.get(key) ?? []), ...structuredClone(records as SessionRecord[])]);
        },
        // Memory has no box to lose: every append is as durable as it gets.
        sync: async () => {},
      };
    },
    keys: () => [...sessions.keys()],
  };
}

/** What a scripted request reports beside its cost, as a real adapter's proxy reads a response, and how it is measured:
 *  its tokens (`tokens`, in pi's shape: `input` excludes the cache's reads and writes; default 10 in, 5 out), the input
 *  bound its body was measured at (`inputTokensMax`; default the prompt's UTF-8 bytes), and a file it waits for once it
 *  is admitted, before it answers (`until`): a request held in flight until a test lets it go. `bookWhen`: its reply is
 *  shown at once and its cost booked only once that file exists, as a provider's usage can come after its answer. */
/** `sideAfterNote`: a client's side call on another model (a title, a summary: ModelRequest.side) admitted and answered
 *  at `usd` after this request took its host's note and before this request is admitted, as a Claude Code side call can
 *  be while the model proxy reads the credential between the two. `sideDuring`: one admitted and answered at `usd` while
 *  this request still streams (after its first call's text, before that call), so two of its requests are in flight.
 *  `sideFirst`: one admitted before this request, then `say` streamed before this request is admitted: text of the
 *  session's (a resumed turn's, say) with no request of this process's own yet, and a side call's the only one open. The
 *  side call is paid at `usd` with this request (at once, or once its `bookWhen` file exists). */
export type FauxRequest = { tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }; inputTokensMax?: number; outputTokensAsked?: number; until?: string; bookWhen?: string; sideAfterNote?: { usd: number }; sideDuring?: { usd: number }; sideFirst?: { usd: number; say: string } };

/** One model request of the faux harness, and what its reply does. */
export type FauxAction =
  | ({ say: string; usd?: number | null } & FauxRequest)
  | ({ call: string; args?: unknown; usd?: number | null } & FauxRequest)
  /** One answer that asks for several tools, run one after another, as Claude Code and Codex run a response's calls.
   *  `bookAfter`: the calls run before the answer's cost is booked, as with Claude Code, whose cost comes in after its
   *  response, so a call can end before the request that asked for it is paid. A call's `say` streams that text first,
   *  as a model writes between the calls of one answer. */
  | ({ calls: { call: string; args?: unknown; say?: string }[]; usd?: number | null; bookAfter?: boolean } & FauxRequest)
  | { submit: unknown; usd?: number | null }
  /** The reply ends the turn without a submission: `completed`, or the status `turn` names (a harness that ends its own
   *  turn interrupted, with no stop asked for, ends it so). */
  | { end: true; usd?: number | null; turn?: TurnStatus }
  /** The request fails: the turn ends failed. */
  | { fail: string }
  /** The process stops here: nothing resolves until the session's signal aborts. */
  | { hang: true }
  /** The harness halts the drive with this reason (a spend cap, a mirror it cannot keep): the turn ends failed, naming it. */
  | { halt: string }
  /** A paid request leaves (its beforeRequest passes) and the process dies before it answers: nothing more resolves. */
  | ({ cut: true } & FauxRequest)
  /** A paid request leaves and holds unanswered until the turn is stopped: the stop cuts it, and its cost (what had
   *  streamed) is still booked, as a provider bills a response cut short. */
  | { cutBooked: true; usd?: number | null };

/** `note`: a note its host had for the request (ModelPort.note, the spend cap's wrap-up), as a real adapter's model proxy
 *  would add it to the body: filed with its text, for a test to see. */
export const FAUX_RECORDS = { request: "faux.request", user: "faux.user", turn: "faux.turn", turnEnd: "faux.turn_end", call: "faux.call", result: "faux.result", note: "faux.note" } as const;

export interface FauxOptions {
  /** The session's model replies, in order, by its spec: one action per paid request. */
  script: (spec: SessionSpec) => FauxAction[];
  /** Whether the faux harness can fork (default false). */
  fork?: boolean;
  /** Problems `check` reports for a spec. */
  refuse?: (spec: SessionSpec) => string[];
  /** How long `open` takes, ignoring the session's signal, as a slow harness start does (default 0). */
  openDelayMs?: number;
}

export interface FauxAdapter extends AgentAdapter {
  /** Paid requests made, across every session and process of this adapter. */
  readonly requests: number;
  /** Tool calls run, by name. */
  readonly calls: string[];
  /** The sessions opened, by key, with the state each was found in. */
  readonly opened: { key: string; state: SessionState }[];
  /** Sessions closed. */
  readonly closed: string[];
}

export function fauxAdapter(options: FauxOptions): FauxAdapter {
  const stats = { requests: 0, calls: [] as string[], opened: [] as { key: string; state: SessionState }[], closed: [] as string[] };
  const adapter: FauxAdapter = {
    id: "faux",
    version: "0.0.0",
    get requests() { return stats.requests; },
    get calls() { return stats.calls; },
    get opened() { return stats.opened; },
    get closed() { return stats.closed; },
    capabilities: () => ({ fork: options.fork ?? false }),
    check: (spec) => [
      ...(spec.context === "fork" && !options.fork ? ["the faux harness cannot fork a session"] : []),
      ...(options.refuse?.(spec) ?? []),
    ],
    async open(spec, io) {
      if (options.openDelayMs) await new Promise((resolve) => setTimeout(resolve, options.openDelayMs));
      const script = options.script(spec);
      const records = await io.writer.read();
      const append = (kind: string, data: JsonValue) => io.writer.append([{ kind, data }]);
      let cursor = records.filter((r) => r.kind === FAUX_RECORDS.request).length;
      const turnsStarted = records.filter((r) => r.kind === FAUX_RECORDS.turn).length;
      const turnsEnded = records.filter((r) => r.kind === FAUX_RECORDS.turnEnd).length;
      let state: SessionState = turnsStarted === 0 ? "new" : turnsStarted > turnsEnded ? "open_turn" : "idle";
      stats.opened.push({ key: spec.key, state });
      // A call whose intent is recorded and whose outcome is not: a crash cut it off. It is answered interrupted, once.
      const results = new Set(records.filter((r) => r.kind === FAUX_RECORDS.result).map((r) => (r.data as { callId: string }).callId));
      for (const r of records.filter((r) => r.kind === FAUX_RECORDS.call)) {
        const { callId } = r.data as { callId: string };
        if (!results.has(callId)) await append(FAUX_RECORDS.result, { callId, interrupted: true });
      }
      const tools = new Map<string, HostTool>(spec.tools.map((tool) => [tool.name, tool]));
      /** What the session has been sent, as a model would be prompted with it. */
      const prompt = records.filter((r) => r.kind === FAUX_RECORDS.user).map((r) => (r.data as { text: string }).text);
      let ending: { promise: Promise<{ status: TurnStatus; error?: string }>; resolve: (end: { status: TurnStatus; error?: string }) => void } | undefined;
      let turnSignal: AbortController | undefined;

      const end = async (status: TurnStatus, error?: string) => {
        // A turn whose end cannot be written (its writer was fenced) still ends: failed, saying why.
        try { await append(FAUX_RECORDS.turnEnd, { status }); } catch (cause) { status = "failed"; error = (cause as Error).message; }
        io.onEvent({ type: "turn_end", status });
        ending?.resolve({ status, ...(error === undefined ? {} : { error }) });
      };
      const untilExists = async (file: string, signal: AbortSignal) => {
        const { existsSync } = await import("node:fs");
        while (!existsSync(file)) {
          if (signal.aborted) throw signal.reason;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      /** The turn's model loop: one scripted action per paid request, until one ends the turn. */
      const run = async () => {
        const signal = AbortSignal.any([io.signal, (turnSignal = new AbortController()).signal]);
        try {
          for (;;) {
            const action = script[cursor];
            if (!action) return await end("completed");
            if ("hang" in action) return await hang(signal);
            if ("halt" in action) { turnSignal!.abort(new Error(action.halt)); return await hang(signal); }
            // Measured as a real adapter's proxy measures its body: the prompt's UTF-8 bytes, with nothing a provider adds.
            const measured = "inputTokensMax" in action && typeof action.inputTokensMax === "number" ? action.inputTokensMax : Buffer.byteLength(JSON.stringify({ system: spec.system, user: prompt }), "utf8");
            // A note its host has for this request, taken before it is measured, as the model proxy takes it: its bytes count
            // in what the request is admitted at, and it is filed as sent once the request is admitted carrying it.
            const note = io.models.note?.("faux");
            if ("sideAfterNote" in action && action.sideAfterNote) {
              const side = await io.models.beforeRequest({ model: "faux-small", side: true, inputTokensMax: 100 });
              await io.models.afterRequest({ input: 10, output: 5, usd: action.sideAfterNote.usd }, side || undefined);
            }
            if ("sideFirst" in action && action.sideFirst) {
              const { usd, say } = action.sideFirst;
              const side = await io.models.beforeRequest({ model: "faux-small", side: true, inputTokensMax: 100 });
              const paySide = () => io.models.afterRequest({ input: 10, output: 5, usd }, side || undefined);
              if ("bookWhen" in action && typeof action.bookWhen === "string") void untilExists(action.bookWhen, signal).then(paySide).catch(() => undefined);
              else await paySide();
              io.onEvent({ type: "text", delta: say });
            }
            // The output it asks for at most (a CLI's max_tokens), as a real adapter's proxy reads it from the body.
            const asked = "outputTokensAsked" in action && typeof action.outputTokensAsked === "number" ? { outputTokensAsked: action.outputTokensAsked } : {};
            const ticket = await io.models.beforeRequest({ model: "faux", inputTokensMax: note ? measured + Buffer.byteLength(note, "utf8") : measured, ...asked, ...(note ? { noted: true as const, inputTokensMaxWithoutNote: measured } : {}) });
            if (note && !ticket?.noteDropped) await append(FAUX_RECORDS.note, { text: note });
            if ("cut" in action) { stats.requests += 1; return await hang(signal); }
            if ("cutBooked" in action) {
              stats.requests += 1;
              await append(FAUX_RECORDS.request, { index: cursor++ });
              try { return await hang(signal); } finally { await io.models.afterRequest({ input: 10, output: 5, usd: action.usd === undefined ? 0.001 : action.usd }); }
            }
            stats.requests += 1;
            const index = cursor++;
            // The output limit it was admitted with (what is left of a spend cap can buy), as a real adapter's proxy would
            // write it into the body: filed, for a test to see.
            const limit = ticket ? ticket.outputTokensMax : undefined;
            await append(FAUX_RECORDS.request, { index, ...(limit === undefined ? {} : { outputTokensMax: limit }) });
            if ("fail" in action) return await end("failed", action.fail);
            // Held in flight, admitted and not answered, until the file it waits for exists (or the turn is stopped).
            if ("until" in action && typeof action.until === "string") await untilExists(action.until, signal);
            const tokens = "tokens" in action && action.tokens ? action.tokens : { input: 10, output: 5 };
            const book = () => io.models.afterRequest({ ...tokens, usd: action.usd === undefined ? 0.001 : action.usd });
            const bookAfter = "calls" in action && action.bookAfter === true;
            if ("bookWhen" in action && typeof action.bookWhen === "string") void untilExists(action.bookWhen, signal).then(book).catch(() => undefined);
            else if (!bookAfter) await book();
            if ("say" in action) io.onEvent({ type: "text", delta: action.say });
            else if ("end" in action) return await end(action.turn ?? "completed");
            else {
              const asked: { name: string; args: unknown; say?: string }[] = "calls" in action ? action.calls.map((c) => ({ name: c.call, args: c.args ?? {}, ...(c.say ? { say: c.say } : {}) }))
                : [{ name: "call" in action ? action.call : "submit", args: "call" in action ? action.args ?? {} : { value: action.submit } }];
              for (const [n, { name, args, say }] of asked.entries()) {
                if (say) io.onEvent({ type: "text", delta: say });
                // A side call (a title, a summary) admitted and answered while this request still streams: two in flight.
                if (n === 0 && "sideDuring" in action && action.sideDuring) {
                  const side = await io.models.beforeRequest({ model: "faux-small", side: true, inputTokensMax: 100 });
                  await io.models.afterRequest({ input: 10, output: 5, usd: action.sideDuring.usd }, side || undefined);
                }
                const callId = "calls" in action ? `${spec.key}:${index}.${n}` : `${spec.key}:${index}`;
                const tool = tools.get(name);
                await append(FAUX_RECORDS.call, { callId, name });
                io.onEvent({ type: "tool_start", callId, name, args });
                const result = tool ? await tool.call(args, { callId, signal }).catch((error: Error) => ({ text: error.message, isError: true })) : { text: `unknown tool ${name}`, isError: true };
                if (tool) stats.calls.push(name);
                await append(FAUX_RECORDS.result, { callId, isError: result.isError === true });
                io.onEvent({ type: "tool_end", callId, name, isError: result.isError === true });
              }
              if (bookAfter) await book();
            }
          }
        } catch (error) {
          // Stopped by the session or its host: interrupted. Halted by anything else: failed, naming why.
          if (signal.aborted) {
            const outcome = abortedOutcome(signal, io.signal);
            if (outcome.status === "interrupted") return void ending?.resolve(outcome);
            return await end("failed", outcome.error);
          }
          return await end("failed", (error as Error).message);
        }
      };
      const begin = () => {
        let resolve!: (end: { status: TurnStatus; error?: string }) => void;
        const promise = new Promise<{ status: TurnStatus; error?: string }>((r) => { resolve = r; });
        ending = { promise, resolve };
        void run();
      };
      const session: AdapterSession = {
        get state() { return state; },
        async send(text) {
          state = "idle";
          await append(FAUX_RECORDS.user, { text });
          prompt.push(text);
          await append(FAUX_RECORDS.turn, { n: turnsStarted + 1 });
          begin();
        },
        async recover() { state = "idle"; begin(); },
        // The open turn ends in the session's records, as a turn's end is written (end()), and nothing runs. Its end is the
        // kernel's for the session's own stop (abortedOutcome of its SessionHalt), as an interrupted turn's is here.
        async settleOpenTurn() {
          if (state !== "open_turn") throw new Error("faux: there is no turn to settle");
          await append(FAUX_RECORDS.turnEnd, { status: abortedOutcome(AbortSignal.abort(new SessionHalt("interrupted"))).status });
          state = "idle";
        },
        turnEnd: () => ending ? ending.promise : Promise.resolve({ status: "completed" }),
        async interrupt() { turnSignal?.abort(new SessionHalt("interrupted")); },
        async close() { turnSignal?.abort(new SessionHalt("closed")); stats.closed.push(spec.key); },
      };
      return session;
    },
  };
  return adapter;
}

