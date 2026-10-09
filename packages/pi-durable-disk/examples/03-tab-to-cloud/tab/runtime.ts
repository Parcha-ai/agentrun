// The agent through the pipe, without the page: pi-durable's Harness over the pipe's Storage, its tools on an execution
// environment (the tab's Wasmer sandbox, or the filesystem of a host that has no disk client), its model calls through
// the pipe, and the write-through after every writing tool. The page (main.ts), a remote host (remote-host.ts) and the
// Node tests start it from an attached PipeClient, an environment and its workspace.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import type { Conversation, HarnessSettings } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { agentModels, agentRegistry, rootAgent, SETTINGS } from "../agent.ts";
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
    note: `${missing.length > 0 ? `There is no ${missing.join(", ")} here. ` : ""}Your model calls go through your user's server.`,
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

export async function startTab<E extends RuntimeEnv>(opts: {
  client: PipeClient;
  attached: Attached;
  env: E;
  workspace: Workspace;
  settings?: HarnessSettings;
  /** The move that brought the run here, and this host's description, for the notice admitted before resuming. */
  move?: { info: SwitchInfo; facts: EnvironmentFacts };
}): Promise<TabRuntime<E>> {
  const { env, workspace } = opts;
  const restored = await workspace.restore(opts.attached.files);
  const syncs: { changes: number; ms: number }[] = [];
  // One write-through at a time: each compares against the baseline the previous one established.
  let line: Promise<void> = Promise.resolve();
  const durable = (_context: Context): Promise<void> => {
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
  const models = agentModels({ baseUrl: "https://model-proxy.invalid/v1", modelId: opts.attached.model, fetch: opts.client.fetch as typeof globalThis.fetch });
  const harness = await Harness.open(remoteStorage(opts.client), { registry: agentRegistry(durable), models, env: () => env, settings: opts.settings ?? SETTINGS }, ctx);
  // The notice is committed before anything the run resumes commits (environment.ts).
  if (opts.move) await admitNotice(harness, rootAgent(opts.attached.model), opts.move.facts, opts.move.info, ctx);
  await harness.resume();
  const root = await harness.root(ctx, { agent: rootAgent(opts.attached.model) });
  return {
    harness,
    root,
    env,
    workspace,
    restored,
    syncs,
    async close() {
      await harness.close(ctx).catch(() => undefined);
      await env.cleanup(ctx).catch(() => undefined);
    },
  };
}
