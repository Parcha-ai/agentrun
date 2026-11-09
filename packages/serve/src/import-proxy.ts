// The setup import runs on a worker thread (import-worker.ts), but the store is the server's, opened once on the main thread
// under an exclusive owner lock no second opener may take. So the worker opens no store of its own: it reaches the server's
// through this narrow proxy over its parentPort. Every read and write the import needs — the agents it writes, the runs it
// lists, the one atomic importRun, the journal reads its dedup does, and the sealed rows the key cut reads — is one message
// to the server, answered against the store it already holds open. The two store errors the import must tell apart from the
// rest (a constraint it dedups on, a busy store) cross the port as their own classes; any other crosses as an Error that
// keeps the thrower's name.
import type { MessagePort } from "node:worker_threads";
import { StoreBusy, StoreConstraint, type JournalReads, type Store } from "./store/index.js";

/** A call from the worker to the server's store: the method by its path (e.g. ["agents","create"], ["flush"], or
 *  ["journal","scanEntries"] with the run id first), its arguments, and `req` to match the reply. */
export type StoreCall = { req: number; path: readonly string[]; args: readonly unknown[] };
/** The server's reply to a `StoreCall`: `ok` with the method's result, or `err` with the thrown error's name and words. */
export type StoreReply = { res: number; ok: unknown } | { res: number; err: { name: string; message: string } };

/** The slice of the store the import reaches over the port: the import's own reads and writes (ImportStore), the sealed rows
 *  and settings the saved-key cut reads (ToolKeysStore), and the trigger settings the server-secret list reads. The real
 *  Store satisfies it, so the server serves calls straight to its open store; the worker's proxy is built to satisfy it too. */
export interface ProxiedStore {
  readonly agents: Pick<Store["agents"], "get" | "create" | "addRevision" | "setCurrent" | "revisions">;
  readonly runs: Pick<Store["runs"], "list">;
  readonly importRun: Store["importRun"];
  readJournal(runId: string): JournalReads;
  readonly triggerSettings: Pick<Store["triggerSettings"], "get" | "put" | "removeScope">;
  readonly sealedKeys: Pick<Store["sealedKeys"], "all" | "put" | "remove">;
  readonly settings: Pick<Store["settings"], "get" | "put">;
  flush(): Promise<void>;
}

/** The journal methods the import's dedup reader calls (journal-reader.ts): each a page scan whose last argument is the
 *  Context, which is not structured-cloneable and is dropped — the server supplies its own. */
const JOURNAL_SCANS = ["scanConversations", "scanEntries", "scanTasks", "scanSubmissions"] as const;

/** An error reply revived on the worker side: the two classes the import tells apart as themselves, any other as an Error
 *  that keeps the name the server sent. */
function reviveError(err: { name: string; message: string }): Error {
  if (err.name === "StoreConstraint") return new StoreConstraint(err.message);
  if (err.name === "StoreBusy") return new StoreBusy(err.message);
  const error = new Error(err.message);
  error.name = err.name;
  return error;
}

/** The worker's view of the server's open store, over `port`. Each method posts one `StoreCall` and awaits its `StoreReply`.
 *  The port is kept referenced only while a call is in flight, so it never keeps the worker's thread alive once the import
 *  is done (as the store it replaces never did), and does keep it alive while it waits for the server. */
export function importStoreProxy(port: MessagePort): ProxiedStore {
  let nextReq = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  port.on("message", (message: unknown) => {
    // Only this proxy's replies; the worker's own "stop" and anything else is left to its other listeners.
    if (typeof message !== "object" || message === null || !("res" in message)) return;
    const reply = message as StoreReply;
    const waiting = pending.get(reply.res);
    if (!waiting) return;
    pending.delete(reply.res);
    if (pending.size === 0) port.unref();
    if ("err" in reply) waiting.reject(reviveError(reply.err));
    else waiting.resolve(reply.ok);
  });
  const call = (path: readonly string[], ...args: readonly unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const req = nextReq++;
      pending.set(req, { resolve, reject });
      if (pending.size === 1) port.ref();
      port.postMessage({ req, path, args } satisfies StoreCall);
    });
  const method = <T>(...path: string[]) => (...args: unknown[]): Promise<T> => call(path, ...args) as Promise<T>;
  // The journal stub: only the four scans the dedup reader uses, each RPC'd with the run id first and the Context dropped.
  const journalStub = (runId: string): JournalReads =>
    Object.fromEntries(JOURNAL_SCANS.map((name) => [name, (query: unknown, limit: unknown, cursor: unknown) => call(["journal", name], runId, query, limit, cursor)])) as unknown as JournalReads;
  return {
    agents: {
      get: method("agents", "get"),
      create: method("agents", "create"),
      addRevision: method("agents", "addRevision"),
      setCurrent: method("agents", "setCurrent"),
      revisions: method("agents", "revisions"),
    },
    runs: { list: method("runs", "list") },
    importRun: method("importRun"),
    readJournal: journalStub,
    triggerSettings: {
      get: method("triggerSettings", "get"),
      put: method("triggerSettings", "put"),
      removeScope: method("triggerSettings", "removeScope"),
    },
    sealedKeys: {
      all: method("sealedKeys", "all"),
      put: method("sealedKeys", "put"),
      remove: method("sealedKeys", "remove"),
    },
    settings: {
      get: method("settings", "get"),
      put: method("settings", "put"),
    },
    flush: method("flush"),
  };
}

/** Answers one `StoreCall` against the server's open `store`: a journal scan opens the run's read-only journal and supplies
 *  the server's own Context; every other call walks the path to the method and applies the arguments. The result is `ok`;
 *  a throw is `err` with its name and words, so the two store classes revive as themselves on the worker. The server posts
 *  the returned reply back to the worker. */
export async function answerStoreCall(store: ProxiedStore, context: unknown, call: StoreCall): Promise<StoreReply> {
  try {
    const ok =
      call.path[0] === "journal"
        ? await journalCall(store, context, call.path[1]!, call.args)
        : await storeCall(store, call.path, call.args);
    return { res: call.req, ok };
  } catch (error) {
    const e = error as { name?: unknown; message?: unknown };
    return { res: call.req, err: { name: typeof e?.name === "string" ? e.name : "Error", message: typeof e?.message === "string" ? e.message : String(error) } };
  }
}

/** A journal scan: the run id is the first argument, the Context the worker dropped is the server's own, added last. */
function journalCall(store: ProxiedStore, context: unknown, name: string, args: readonly unknown[]): Promise<unknown> {
  const [runId, ...rest] = args as [string, ...unknown[]];
  const journal = store.readJournal(runId) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  return journal[name]!(...rest, context);
}

/** Walks `path` to its method on the store and applies `args` (e.g. ["agents","create"] -> store.agents.create(...args)). */
function storeCall(store: ProxiedStore, path: readonly string[], args: readonly unknown[]): Promise<unknown> {
  let owner: Record<string, unknown> = store as unknown as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) owner = owner[path[i]!] as Record<string, unknown>;
  const fn = owner[path[path.length - 1]!] as (...a: unknown[]) => Promise<unknown>;
  return fn.apply(owner, args as unknown[]);
}
