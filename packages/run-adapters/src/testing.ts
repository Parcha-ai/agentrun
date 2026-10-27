// Test kit: a session store in memory, and a scripted harness with no model and no network. The faux harness keeps its
// own records in the store as a real adapter does (the requests it made, each tool call's intent and outcome, its turns),
// so a later process resumes from them: a request already made is not made again, and a call a crash cut off is
// answered interrupted, never run again.
import type { AdapterSession, AgentAdapter, HostTool, JsonValue, SessionRecord, SessionSpec, SessionState, SessionStore, TurnStatus } from "./types.js";

/** A session store in memory: what one run's store holds, across the processes a test plays. */
export function memorySessionStore(): SessionStore & { keys(): string[] } {
  const sessions = new Map<string, SessionRecord[]>();
  return {
    async read(key) { return structuredClone(sessions.get(key) ?? []); },
    async append(key, records) { sessions.set(key, [...(sessions.get(key) ?? []), ...structuredClone(records as SessionRecord[])]); },
    keys: () => [...sessions.keys()],
  };
}

/** One model request of the faux harness, and what its reply does. */
export type FauxAction =
  | { say: string; usd?: number | null }
  | { call: string; args?: unknown; usd?: number | null }
  | { submit: unknown; usd?: number | null }
  /** The reply ends the turn without a submission. */
  | { end: true; usd?: number | null }
  /** The request fails: the turn ends failed. */
  | { fail: string }
  /** The process stops here: nothing resolves until the session's signal aborts. */
  | { hang: true }
  /** A paid request leaves (its beforeRequest passes) and the process dies before it answers: nothing more resolves. */
  | { cut: true };

export const FAUX_RECORDS = { request: "faux.request", user: "faux.user", turn: "faux.turn", turnEnd: "faux.turn_end", call: "faux.call", result: "faux.result" } as const;

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
      const records = await io.store.read(spec.key);
      const append = (kind: string, data: JsonValue) => io.store.append(spec.key, [{ kind, data }]);
      let cursor = records.filter((r) => r.kind === FAUX_RECORDS.request).length;
      const turnsStarted = records.filter((r) => r.kind === FAUX_RECORDS.turn).length;
      const turnsEnded = records.filter((r) => r.kind === FAUX_RECORDS.turnEnd).length;
      const state: SessionState = turnsStarted === 0 ? "new" : turnsStarted > turnsEnded ? "open_turn" : "idle";
      stats.opened.push({ key: spec.key, state });
      // A call whose intent is recorded and whose outcome is not: a crash cut it off. It is answered interrupted, once.
      const results = new Set(records.filter((r) => r.kind === FAUX_RECORDS.result).map((r) => (r.data as { callId: string }).callId));
      for (const r of records.filter((r) => r.kind === FAUX_RECORDS.call)) {
        const { callId } = r.data as { callId: string };
        if (!results.has(callId)) await append(FAUX_RECORDS.result, { callId, interrupted: true });
      }
      const tools = new Map<string, HostTool>(spec.tools.map((tool) => [tool.name, tool]));
      let ending: { promise: Promise<{ status: TurnStatus; error?: string }>; resolve: (end: { status: TurnStatus; error?: string }) => void } | undefined;
      let turnSignal: AbortController | undefined;

      const end = async (status: TurnStatus, error?: string) => {
        await append(FAUX_RECORDS.turnEnd, { status });
        io.onEvent({ type: "turn_end", status });
        ending?.resolve({ status, ...(error === undefined ? {} : { error }) });
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
            await io.models.beforeRequest({ model: "faux" });
            if ("cut" in action) { stats.requests += 1; return await hang(signal); }
            stats.requests += 1;
            const index = cursor++;
            await append(FAUX_RECORDS.request, { index });
            if ("fail" in action) return await end("failed", action.fail);
            await io.models.afterRequest({ input: 10, output: 5, usd: action.usd === undefined ? 0.001 : action.usd });
            if ("say" in action) io.onEvent({ type: "text", delta: action.say });
            else if ("end" in action) return await end("completed");
            else {
              const name = "call" in action ? action.call : "submit";
              const args = "call" in action ? action.args ?? {} : { value: action.submit };
              const callId = `${spec.key}:${index}`;
              const tool = tools.get(name);
              await append(FAUX_RECORDS.call, { callId, name });
              io.onEvent({ type: "tool_start", callId, name, args });
              const result = tool ? await tool.call(args, { callId, signal }).catch((error: Error) => ({ text: error.message, isError: true })) : { text: `unknown tool ${name}`, isError: true };
              if (tool) stats.calls.push(name);
              await append(FAUX_RECORDS.result, { callId, isError: result.isError === true });
              io.onEvent({ type: "tool_end", callId, name, isError: result.isError === true });
            }
          }
        } catch (error) {
          if (signal.aborted) return void ending?.resolve({ status: "interrupted" });
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
        state,
        async send(text) {
          await append(FAUX_RECORDS.user, { text });
          await append(FAUX_RECORDS.turn, { n: turnsStarted + 1 });
          begin();
        },
        async recover() { begin(); },
        turnEnd: () => ending ? ending.promise : Promise.resolve({ status: "completed" }),
        async interrupt() { turnSignal?.abort(new Error("interrupted")); },
        async close() { turnSignal?.abort(new Error("closed")); stats.closed.push(spec.key); },
      };
      return session;
    },
  };
  return adapter;
}

