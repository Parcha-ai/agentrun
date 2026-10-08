// Shared by the park, serve and fork suites: a "disk" over a local directory (the control API's objects, delegations
// and token users, plus a claim per run that the delegations track), and an app on pi-ai's faux model with Rivet's
// lifecycle cases: a flaky model that errors once, tools that block until the run stops, and a task of the app's own.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import type { Delegation } from "disk";
import { runPath, type Claim, type RunRef } from "../src/claim.ts";
import { archilEnv } from "../src/env.ts";
import { HeldError } from "../src/errors.ts";
import { openDurableRun, type DurableRun, type OpenDurableRunOptions, type RunEnv } from "../src/run.ts";
import type { CheckControl, HostDriver, HostHandle, HostStatus, SupervisorControl } from "../src/supervise.ts";
import { fakeClaim, localClaimDir, type FakeClaim } from "./_run-support.ts";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(what: string, fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const notFound = () => Object.assign(new Error("NoSuchKey"), { status: 404, code: "NoSuchKey" });

/**
 * A disk over a local directory: `runs/<id>/` is `<base>/runs/<id>/`. Objects are files (a key ending in `/` is a
 * directory marker), delegations are the claims `acquire` handed out and not yet released, token users are a map.
 */
export class LocalDisk implements SupervisorControl, CheckControl {
  readonly base: string;
  readonly delegations: Delegation[] = [];
  readonly users = new Map<string, string>();
  readonly claims: FakeClaim[] = [];
  #n = 0;
  constructor(prefix: string) {
    this.base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `pda-${prefix}-`));
  }
  remove(): void {
    rmSync(this.base, { recursive: true, force: true });
  }
  path(key: string): string {
    return join(this.base, key);
  }
  async getObject(key: string): Promise<Uint8Array> {
    try {
      return readFileSync(this.path(key));
    } catch {
      throw notFound();
    }
  }
  async headObject(key: string): Promise<unknown | null> {
    try {
      const st = statSync(this.path(key));
      return key.endsWith("/") === st.isDirectory() ? { size: st.size } : null;
    } catch {
      return null;
    }
  }
  async putObject(key: string, body: string): Promise<unknown> {
    if (key.endsWith("/")) mkdirSync(this.path(key), { recursive: true });
    else (mkdirSync(dirname(this.path(key)), { recursive: true }), writeFileSync(this.path(key), body));
    return {};
  }
  async listObjects(prefix: string): Promise<{ objects: { key: string }[]; commonPrefixes: string[] }> {
    const objects: { key: string }[] = [];
    const walk = (key: string) => {
      let names: string[];
      try {
        names = readdirSync(this.path(key));
      } catch {
        return;
      }
      for (const name of names) {
        const child = `${key}${name}`;
        if (statSync(this.path(child)).isDirectory()) (objects.push({ key: `${child}/` }), walk(`${child}/`));
        else objects.push({ key: child });
      }
    };
    if (statSync(this.path(prefix), { throwIfNoEntry: false })?.isDirectory()) (objects.push({ key: prefix }), walk(prefix));
    return { objects, commonPrefixes: [] };
  }
  /** As S3 on an Archil disk: nothing under a delegation is deleted, and a directory with entries refuses. */
  async deleteObjects(keys: string[]): Promise<{ errors: unknown[] }> {
    const errors: unknown[] = [];
    for (const key of keys) {
      if (this.delegations.some((d) => key === `${d.path}/` || key.startsWith(`${d.path}/`))) continue;
      try {
        if (key.endsWith("/")) rmdirSync(this.path(key));
        else rmSync(this.path(key), { force: true });
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") errors.push({ key, error: (error as Error).message });
      }
    }
    return { errors };
  }
  async addUser(user: { nickname: string }): Promise<{ identifier: string; token: string }> {
    const identifier = `u${++this.#n}`;
    this.users.set(identifier, user.nickname);
    return { identifier, token: `token-${identifier}` };
  }
  async removeUser(_type: "token", identifier: string): Promise<void> {
    this.users.delete(identifier);
  }
  async listDelegations(): Promise<Delegation[]> {
    return this.delegations.map((d) => ({ ...d }));
  }
  async revokeDelegation(d: Pick<Delegation, "clientId" | "inodeId">): Promise<void> {
    const i = this.delegations.findIndex((x) => x.clientId === d.clientId && x.inodeId === d.inodeId);
    if (i >= 0) this.delegations.splice(i, 1);
  }
  /** The claim on `ref`'s directory, refused while another claim holds it (an exclusive mount). */
  acquire(ref: RunRef): Claim {
    const path = runPath(ref.id);
    if (this.delegations.some((d) => d.path === path)) throw new HeldError("claim", `${path} is held`);
    const delegation = { clientId: `c${++this.#n}`, inodeId: this.#n, path, isPending: false, isOrphaned: false };
    this.delegations.push(delegation);
    mkdirSync(this.path(`${path}/`), { recursive: true });
    const claim = fakeClaim(this.path(path), ref, { release: async () => void this.revokeDelegation(delegation) });
    this.claims.push(claim);
    return claim;
  }
}

/** What the app's tools and model did, in this process. */
export type Counters = { flaky: number; safe: number; unsafe: number; requests: number; gate: number };

/** Resolves when `signal` aborts. */
const aborted = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** A task that runs until the run stops it; the definition of an app extension `jobs`. */
export const JobTask = defineTask<Record<string, never>, { phase: "run" }, null>({
  name: "app.job",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: { run: async (_task, _runtime, context) => aborted(context.abortSignal) },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
export const Jobs = defineExtension({ name: "jobs", tasks: [JobTask] });

const textOf = (m: { role: string; content?: unknown } | undefined): string =>
  m?.role !== "user" ? "" : typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((c) => c.text ?? "").join("");

/**
 * The scripted model (Rivet's cases): "flaky" errors once (retryable) and then answers "recovered"; "use both tools"
 * calls `safe_tool` and `unsafe_tool`; "gate" calls `gate_tool`; a tool result is answered "finished"; anything else
 * "echo: <text>".
 */
export function lifecycleReply(counters: Counters): FauxResponseFactory {
  return (context) => {
    counters.requests++;
    const last = context.messages.findLast((m) => (m.role as string) !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage("finished");
    const text = textOf(last);
    if (text === "flaky") {
      return counters.flaky++ === 0 ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: Overloaded" }) : fauxAssistantMessage("recovered");
    }
    if (text === "use both tools") return fauxAssistantMessage([fauxToolCall("safe_tool", {}), fauxToolCall("unsafe_tool", {})], { stopReason: "toolUse" });
    if (text === "gate") return fauxAssistantMessage(fauxToolCall("gate_tool", {}), { stopReason: "toolUse" });
    return fauxAssistantMessage(`echo: ${text}`);
  };
}

export interface LifecycleOptions {
  /** The retry backoff of the flaky model, in ms. */
  readonly retryMs?: number;
  /** Install the `jobs` extension (default true). */
  readonly jobs?: boolean;
  /** `gate_tool` waits on this before it returns (or until the run stops it). */
  readonly gate?: Promise<void>;
}

/** Harness options for the lifecycle app; `counters` may be shared across incarnations to count across them. */
export function lifecycleApp(counters: Counters, options: LifecycleOptions = {}) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 500 }, () => lifecycleReply(counters)));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  // A tool's first run blocks until the run stops it; a rerun returns at once.
  const waiting = (name: "safe" | "unsafe", replay: "safe" | "unsafe") =>
    defineTool({
      name: `${name}_tool`,
      description: `A ${replay} tool that waits`,
      parameters: Type.Object({}),
      replay,
      execute: async (_args, _api, context) => {
        counters[name] += 1;
        if (counters[name] === 1) await aborted(context.abortSignal);
        context.abortSignal?.throwIfAborted();
        return { content: [{ type: "text", text: `${name} done` }] };
      },
    });
  const gate = defineTool({
    name: "gate_tool",
    description: "Waits for the test's gate",
    parameters: Type.Object({}),
    execute: async (_args, _api, context) => {
      counters.gate += 1;
      await Promise.race([options.gate ?? new Promise(() => {}), aborted(context.abortSignal)]);
      context.abortSignal?.throwIfAborted();
      return { content: [{ type: "text", text: "gate open" }] };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "tools", tools: [waiting("safe", "safe"), waiting("unsafe", "unsafe"), gate] }));
  if (options.jobs !== false) registry.install(Jobs);
  const settings: HarnessSettings = { retry: { baseDelayMs: options.retryMs ?? 60_000, maxAgentDelayMs: options.retryMs ?? 60_000 } };
  return { models, registry, settings, agent: { model: { provider: model.provider, modelId: model.id } } };
}

export const newCounters = (): Counters => ({ flaky: 0, safe: 0, unsafe: 0, requests: 0, gate: 0 });

/** The run's environment, with `cleanup` logged into the claim's log. */
function loggedEnv(c: Claim): RunEnv {
  const factory = archilEnv(c);
  return Object.assign((target: { cwd?: string }) => factory(target), {
    id: factory.id,
    cleanup: async (context: Context) => {
      (c as FakeClaim).log.push("cleanup");
      await factory.cleanup(context);
    },
  });
}

/** Open `ref` on `disk` with `harness`; fences are collected (no exit), every run.json write logged in the claim's log. */
export function openOn(
  disk: LocalDisk,
  ref: RunRef,
  harness: OpenDurableRunOptions["harness"],
  extra: Partial<OpenDurableRunOptions> & { fenced?: unknown[] } = {},
): Promise<DurableRun> {
  let claim: FakeClaim | undefined;
  return openDurableRun(ref, {
    mountToken: "unused",
    acquire: async () => (claim = disk.acquire(ref) as FakeClaim),
    claimDir: localClaimDir,
    harness,
    env: loggedEnv,
    onFenced: (error) => void extra.fenced?.push(error),
    persist: async (root, text, signal) => {
      claim?.log.push(`run.json ${JSON.parse(text).status}`);
      const { persistRecord } = await import("../src/status.ts");
      await (extra.persist ?? persistRecord)(root, text, signal);
    },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "persist" && k !== "fenced")),
  });
}

/** A host driver that opens instances in this process (the test supplies how). */
export class InProcessHost implements HostDriver {
  readonly starts: RunRef[] = [];
  readonly #start: (ref: RunRef) => Promise<void>;
  constructor(start: (ref: RunRef) => Promise<void>) {
    this.#start = start;
  }
  async start(ref: RunRef): Promise<HostHandle> {
    this.starts.push(ref);
    await this.#start(ref);
    return { driver: "in-process", n: this.starts.length };
  }
  async status(): Promise<HostStatus> {
    return "unknown";
  }
  async stop(): Promise<void> {}
}
