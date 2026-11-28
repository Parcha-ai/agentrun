import { type ComputerProvider, providerFor, type Result, RUN_LABEL } from "@parcha/agentrun-computer";
import type { ProviderLoad } from "./workspace/computer-providers.js";

export type EvalComputerCleanupIssue = {
  run_id: string;
  computer: string;
} & ({ status: "timed_out" } | { status: "failed"; reason: string });

type Tracked = {
  runId: string;
  done: Promise<void>;
  settle: () => void;
  failure?: string;
  release?: Promise<Result<void>>;
};

function pendingRelease(): Pick<Tracked, "done" | "settle"> {
  let settle!: () => void;
  const done = new Promise<void>((resolve) => { settle = resolve; });
  return { done, settle };
}

/** An eval owns the Docker computers it created. Track their deletes across provider instances: the run-end
 *  hook can release a computer through a different instance from the one that created it. */
export class EvalComputerCleanup {
  readonly #computers = new Map<string, Tracked>();
  readonly #deadline = new AbortController();
  #waitUntil = Infinity;

  readonly load: ProviderLoad = async (id, options) => this.track(await providerFor(id, options));

  track(provider: ComputerProvider): ComputerProvider {
    if (provider.id !== "docker") return provider;
    const create: ComputerProvider["create"] = async (spec, context) => {
      const created = await provider.create(spec, context);
      const runId = spec.labels?.[RUN_LABEL];
      if (created.ok && runId && !spec.owner && !this.#computers.has(created.value.name)) {
        this.#computers.set(created.value.name, { runId, ...pendingRelease() });
      }
      return created;
    };
    const release: ComputerProvider["release"] = (ref, how, context) => {
      const tracked = how === "delete" ? this.#computers.get(ref.name) : undefined;
      if (!tracked) return provider.release(ref, how, context);
      if (tracked.release) return tracked.release;
      if (tracked.failure !== undefined) {
        Object.assign(tracked, pendingRelease());
        delete tracked.failure;
      }
      const signal = context?.signal ? AbortSignal.any([context.signal, this.#deadline.signal]) : this.#deadline.signal;
      tracked.release = provider.release(ref, how, { ...context, signal }).then((result) => {
        if (performance.now() <= this.#waitUntil) {
          if (result.ok) this.#computers.delete(ref.name);
          else tracked.failure = result.error.message;
        }
        return result;
      }, (error: unknown) => {
        if (performance.now() <= this.#waitUntil) tracked.failure = error instanceof Error ? error.message : String(error);
        throw error;
      }).finally(() => {
        delete tracked.release;
        tracked.settle();
      });
      return tracked.release;
    };
    return new Proxy(provider, {
      get(target, key) {
        if (key === "create") return create;
        if (key === "release") return release;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  begin(timeoutMs: number): void {
    this.#waitUntil = performance.now() + timeoutMs;
  }

  async finish(): Promise<EvalComputerCleanupIssue[]> {
    const waiting = () => [...this.#computers.values()].filter(({ failure }) => failure === undefined);
    let pending = waiting();
    if (pending.length === 0) return this.#issues();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, this.#waitUntil - performance.now()));
    });
    try {
      while (pending.length && performance.now() <= this.#waitUntil) {
        const settled = await Promise.race([Promise.all(pending.map(({ done }) => done)).then(() => true), expired]);
        if (!settled) break;
        pending = waiting();
      }
    } finally {
      clearTimeout(timer);
    }
    const issues = this.#issues();
    // Snapshot first: a Docker command aborted at the deadline is a timeout in this report.
    if (issues.some(({ status }) => status === "timed_out")) this.#deadline.abort();
    return issues;
  }

  #issues(): EvalComputerCleanupIssue[] {
    return [...this.#computers].map(([computer, { runId: run_id, failure }]) => failure === undefined
      ? { run_id, computer, status: "timed_out" }
      : { run_id, computer, status: "failed", reason: failure });
  }
}
