// The agent through the pipe, without the page: pi-durable's Harness over the pipe's Storage, its tools on an execution
// environment (the tab's Wasmer sandbox, or the filesystem of a host that has no disk client), its model calls through
// the pipe, and the write-through after every writing tool. The page (main.ts), a remote host (remote-host.ts) and the
// Node tests start it from an attached PipeClient, an environment and its workspace.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import type { Conversation, HarnessSettings } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { agentModels, agentRegistry, rootAgent, SETTINGS, type HostTools } from "../agent.ts";
import { admitNotice, type EnvironmentFacts, type SwitchInfo } from "../environment.ts";
import { remoteStorage, type Attached, type PipeClient } from "./pipe-client.ts";
import type { Workspace } from "./workspace.ts";

/** The environment the runtime owns: cleaned up when it closes. */
export type RuntimeEnv = ExecutionEnv;

export interface TabRuntime<E extends RuntimeEnv = RuntimeEnv> {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly env: E;
  readonly workspace: Workspace;
  readonly restored: { files: number; bytes: number; skipped: string[] };
  /** The write-throughs this tab made: changes sent, and how long each took, end to end. */
  readonly syncs: { changes: number; ms: number }[];
  /** Stop the periodic write-through (`liveFlushMs`) and wait for the one in flight: nothing syncs after this but a tool's own end. */
  stopLive(): Promise<void>;
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
  let harness: Awaited<ReturnType<typeof Harness.open>>;
  let root: Awaited<ReturnType<Awaited<ReturnType<typeof Harness.open>>["root"]>>;
  // A setup that fails stops the timer it started: no runtime is returned, so nothing else would.
  try {
    const models = agentModels({ baseUrl: "https://model-proxy.invalid/v1", modelId: opts.attached.model, fetch: opts.client.fetch as typeof globalThis.fetch });
    harness = await Harness.open(remoteStorage(opts.client), { registry: agentRegistry(durable, { ...opts.host, ...(opts.attached.placed ? { switchTool: false } : {}), environments: opts.host?.environments ?? opts.attached.environments.map((e) => e.id) }), models, env: () => env, settings: opts.settings ?? SETTINGS }, ctx);
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
    env,
    workspace,
    restored,
    syncs,
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
