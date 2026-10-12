// The agent through the pipe, without the page: pi-durable's Harness over the pipe's Storage, its tools on an execution
// environment (the tab's Wasmer sandbox, or the filesystem of a host that has no disk client), its model calls through
// the pipe, and the write-through after every writing tool. The page (main.ts), a remote host (remote-host.ts) and the
// Node tests start it from an attached PipeClient, an environment and its workspace.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import type { Conversation, HarnessSettings, Storage } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import type { MutableModels } from "@earendil-works/pi-ai";
import { agentModels, agentRegistry, rootAgent, SETTINGS, type HostTools } from "../agent.ts";
import type { Registry } from "@earendil-works/pi-durable";
import { admitNotice, type EnvironmentFacts, type SwitchInfo } from "../environment.ts";
import { remoteStorage, type Attached, type PipeClient } from "./pipe-client.ts";
import type { Workspace } from "./workspace.ts";

/** The environment the runtime owns: cleaned up when it closes. */
export type RuntimeEnv = ExecutionEnv;

export interface TabRuntime<E extends RuntimeEnv = RuntimeEnv> {
  readonly harness: Harness;
  readonly root: Conversation;
  /** The model registry the Harness uses: the page adds the `tab-local` provider to it when the trained model comes home (brain.ts). */
  readonly models: MutableModels;
  /** The tools registry the Harness runs with: the page takes the coding tools from it when it configures the conversation onto the trained model (brain.ts, mode configure). */
  readonly registry: Registry;
  readonly env: E;
  readonly workspace: Workspace;
  readonly restored: { files: number; bytes: number; skipped: string[] };
  /** The write-throughs this tab made: changes sent, and how long each took, end to end. */
  readonly syncs: { changes: number; ms: number }[];
  /** Stop the periodic write-through (`liveFlushMs`) and wait for the one in flight: nothing syncs after this but a tool's own end. */
  stopLive(): Promise<void>;
  /** Write the workspace's changes out now: to this browser's copy offline, to the pipe online (after a tool they go by themselves; a page that changes files itself, the robot pane, asks for it). */
  flush?(): Promise<void>;
  close(): Promise<void>;
}

/** The tab as a host: what the agent can count on here (built from the sandbox's own command list and the browser). */
export function tabFacts(commands: readonly string[], browser: { cpus?: number; memoryGb?: number; userAgent?: string } = {}): EnvironmentFacts {
  const tools = ["bash", "node", "npm", "pnpm", "python3", "git", "curl", "grep", "sed"].filter((c) => commands.includes(c));
  if (commands.includes("ls") && commands.includes("cat")) tools.push("coreutils (ls, cat, sort, wc, ...)");
  const missing = ["grep", "sed", "python3", "git", "curl"].filter((c) => !commands.includes(c));
  return {
    label: "your user's browser tab",
    hostClass: "a WebAssembly sandbox (Wasmer) inside the page",
    cpus: browser.cpus ?? null,
    memoryGb: browser.memoryGb ?? null,
    gpu: null,
    tools,
    network: false,
    note: `This is one WebAssembly process inside a browser page (32-bit, at most 4 GB of memory), not a full computer; training and other heavy work belong on another machine. ${missing.length > 0 ? `There is no ${missing.join(", ")} here. ` : ""}Your model calls go through your user's server.`,
  };
}

/**
 * Let the step in progress end: the model requests and tool calls running now settle (their results commit), or
 * `timeoutMs` passes. What starts after that is cut by the close and resumed by the next host.
 */
export async function finishStep(harness: Harness, timeoutMs: number): Promise<"idle" | "step" | "timeout"> {
  const deadline = performance.now() + timeoutMs;
  const running = async () =>
    new Set((await harness.inspect(ctx)).tasks.filter((t) => t.state.kind === "running" && (t.record.kind === "pi.tool" || t.record.kind === "pi.generation")).map((t) => String(t.record.id)));
  const first = await running();
  if (first.size === 0) return "idle";
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const now = await running();
    if (![...first].some((id) => now.has(id))) return "step";
  }
  return "timeout";
}

/**
 * Wait until nothing is running: `finishStep` until it says idle (a step that ends may be followed by the next of the same turn, and a tool that asked for this very move is itself a step that has
 * not ended yet when the page starts waiting). "timeout" when the agent is still going after `timeoutMs`.
 */
export async function untilIdle(harness: Harness, timeoutMs: number): Promise<"idle" | "timeout"> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const left = deadline - performance.now();
    if (left <= 0) return "timeout";
    const how = await finishStep(harness, left);
    if (how === "idle") return "idle";
    if (how === "timeout") return "timeout";
    await new Promise((r) => setTimeout(r, 50)); // a step ended: look again, the turn may have another
  }
}

/**
 * A write-through every `ms` while started. A tick that finds the previous one still running is skipped, so a slow sync
 * (a large checkpoint) never queues more behind it; `stop` ends the ticks and waits for the one in flight.
 */
export function startLiveFlush(flush: () => Promise<void>, ms: number): { stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (inFlight) return;
    const run = flush().catch(() => undefined).finally(() => void (inFlight = undefined));
    inFlight = run;
  }, ms);
  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
    },
  };
}

export async function startTab<E extends RuntimeEnv>(opts: {
  client: PipeClient;
  attached: Attached;
  env: E;
  workspace: Workspace;
  settings?: HarnessSettings;
  /** What this host offers the agent beyond the shared tools (the move tool over this host's channel). */
  host?: HostTools;
  /** The move that brought the run here, and this host's description, for the notice admitted before resuming. */
  move?: { info: SwitchInfo; facts: EnvironmentFacts };
  /**
   * Also write through every this many milliseconds while the run is open, so what a long tool call writes (a training
   * checkpoint) reaches the disk and the viewers while the call is still running. Without it a tool's files become durable
   * only when its call ends. Each tick is one more write-through on the same line, so ticks and tool ends never overlap.
   */
  liveFlushMs?: number;
}): Promise<TabRuntime<E>> {
  const { env, workspace } = opts;
  workspace.setLazy(opts.attached.noRestore ?? []);
  const restored = await workspace.restore(opts.attached.files);
  const syncs: { changes: number; ms: number }[] = [];
  // One write-through at a time: each compares against the baseline the previous one established.
  let line: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    const next = line.then(async () => {
      const started = performance.now();
      const { changes, scanned } = await workspace.changes();
      if (changes.length > 0) await opts.client.syncFiles(changes);
      workspace.accept(scanned);
      syncs.push({ changes: changes.length, ms: performance.now() - started });
    });
    line = next.catch(() => undefined);
    return next;
  };
  const durable = (_context: Context): Promise<void> => flush();
  const live = opts.liveFlushMs && opts.liveFlushMs > 0 ? startLiveFlush(flush, opts.liveFlushMs) : undefined;
  let models: ReturnType<typeof agentModels>;
  let registry: Registry;
  let harness: Awaited<ReturnType<typeof Harness.open>>;
  let root: Awaited<ReturnType<Awaited<ReturnType<typeof Harness.open>>["root"]>>;
  // A setup that fails stops the timer it started: no runtime is returned, so nothing else would.
  try {
    models = agentModels({ baseUrl: "https://model-proxy.invalid/v1", modelId: opts.attached.model, fetch: opts.client.fetch as typeof globalThis.fetch });
    registry = agentRegistry(durable, { ...opts.host, ...(opts.attached.placed ? { switchTool: false } : {}), environments: opts.host?.environments ?? opts.attached.environments.map((e) => e.id) });
    harness = await Harness.open(remoteStorage(opts.client), { registry, models, env: () => env, settings: opts.settings ?? SETTINGS }, ctx);
    // The notice is committed before anything the run resumes commits (environment.ts).
    if (opts.move) await admitNotice(harness, rootAgent(opts.attached.model), opts.move.facts, opts.move.info, ctx);
    await harness.resume();
    root = await harness.root(ctx, { agent: rootAgent(opts.attached.model) });
  } catch (error) {
    await live?.stop();
    throw error;
  }
  return {
    harness,
    root,
    models,
    registry,
    env,
    workspace,
    restored,
    syncs,
    flush,
    async stopLive() {
      await live?.stop();
    },
    async close() {
      await live?.stop();
      await harness.close(ctx).catch(() => undefined);
      await env.cleanup(ctx).catch(() => undefined);
    },
  };
}

/** An environment for a run with no computer (checked out to a browser): every operation reports that nothing is available, so a tool call fails with that reason and the Harness still opens. */
function noComputer(): RuntimeEnv {
  const unavailable = () => Promise.resolve({ ok: false, error: Object.assign(new Error("there is no computer while the run is checked out to this browser"), { code: "not_supported" }) });
  const base: Record<string, unknown> = { id: "offline", cwd: "/", cleanup: async () => undefined };
  // Not `then` (an environment returned from an async function would be taken for a thenable that never settles), nor a symbol.
  return new Proxy(base, { get: (target, key) => (typeof key === "symbol" || key === "then" ? undefined : key in target ? target[key] : unavailable) }) as unknown as RuntimeEnv;
}

/** What the page shows of a workspace when there is none: no files, nothing to compare. */
function noWorkspace(): Workspace {
  return { list: async () => [], baselineDigest: async () => "", setLazy: () => undefined, restore: async () => ({ files: 0, bytes: 0, skipped: [] }), changes: async () => ({ changes: [], scanned: new Map() }), accept: () => undefined } as unknown as Workspace;
}

/**
 * The agent from a store in this browser, no pipe, no cloud model (its calls fail at once, by name). Its hands are `computer` (the page's Wasmer sandbox and its workspace) when
 * there is one, else nothing: every tool call fails saying there is no computer. After a tool the workspace's changes go to `persist` (the page's OPFS copy), not to a pipe; `flush`
 * does the same on demand. The trained model is added to `models` by the page (brain.ts) once it is loaded. `close` closes the storage.
 */
export async function startLocal(opts: {
  storage: Storage;
  model: string;
  settings?: HarnessSettings;
  computer?: { env: RuntimeEnv; workspace: Workspace };
  persist?: (changes: Awaited<ReturnType<Workspace["changes"]>>["changes"]) => Promise<void>;
  /** What this host's page offers the agent's tools (go_online, here). */
  host?: HostTools;
  /**
   * Do not resume the run's interrupted work yet: the caller calls `harness.resume()` once it can serve it. A page whose model loads after the store opens (the
   * phone) resumes a turn a reload cut short only when the model is there; resumed at open, that turn ran with no provider and vanished.
   */
  deferResume?: boolean;
}): Promise<TabRuntime> {
  const env = opts.computer?.env ?? noComputer();
  const workspace = opts.computer?.workspace ?? noWorkspace();
  const models = agentModels({ baseUrl: "https://offline.invalid/v1", modelId: opts.model, fetch: (() => Promise.reject(new Error("the run is checked out to this browser: the cloud model is out of reach"))) as typeof globalThis.fetch });
  // One flush at a time: each compares against the baseline the previous one established, as startTab's write-through does.
  let line: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    if (!opts.computer || !opts.persist) return Promise.resolve();
    const next = line.then(async () => {
      const { changes, scanned } = await workspace.changes();
      if (changes.length > 0) await opts.persist!(changes);
      workspace.accept(scanned);
    });
    line = next.catch(() => undefined);
    return next;
  };
  const registry = agentRegistry((_context: Context) => flush(), { switchTool: false, environments: [], ...opts.host });
  const harness = await Harness.open(opts.storage, { registry, models, env: () => env, settings: opts.settings ?? SETTINGS }, ctx);
  if (!opts.deferResume) await harness.resume();
  const root = await harness.root(ctx, { agent: rootAgent(opts.model) });
  return {
    harness,
    root,
    models,
    registry,
    env,
    workspace,
    restored: { files: 0, bytes: 0, skipped: [] },
    syncs: [],
    flush,
    async stopLive() {},
    async close() {
      await harness.close(ctx).catch(() => undefined);
      await opts.computer?.env.cleanup(ctx).catch(() => undefined);
    },
  };
}
