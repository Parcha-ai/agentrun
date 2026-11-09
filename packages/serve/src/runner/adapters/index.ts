// The harnesses the runner's loop factory runs, by the launch's harness name: the runner reads the run's launch at its
// claim, maps it to what every adapter is given (HarnessLaunch), and asks resolveHarness(launch.harness) for the harness's
// adapter and who keeps the run's visible record. pi keeps its own (its tasks and entries); a CLI harness's own records
// are resume log only, so the loop keeps its record (record: "loop"). A CLI package is loaded when its harness is first
// asked for, as serve loads it today (it may install on first use).
import type { AgentAdapter, Wire } from "@parcha/agentrun-kernel";
import type { AdapterRun } from "../adapter-loop.js";
import { piAdapter } from "./pi.js";

/** What every adapter is given for one claim, from the run's launch. */
export interface HarnessLaunch {
  /** The claim's run: its Harness on the run's journal (pi adds its turns to it). */
  readonly run: AdapterRun;
  /** The model the run asks for, as the launch names it. */
  readonly model: string;
  /** Where the session's model proxy forwards: the provider's origin, its credential (asked for when a request leaves)
   *  and any headers the launch's provider takes; `api`, the wire it speaks (pi's proxy policy and client follow it; a CLI
   *  harness speaks its own, AdapterFacts.wire). Absent: Anthropic's Messages. */
  readonly provider: { readonly api?: Wire; readonly origin: string; readonly credential: () => string | Promise<string>; readonly headers?: Readonly<Record<string, string>>; readonly auth?: "bearer" | "x-api-key" };
  /** The price of a request's usage, for the proxy's booking (the runner's one ledger). */
  readonly price?: (model: string, usage: never) => number | null;
  /** Where a CLI session keeps its private directory (its HOME and the CLI's own files), one per session key. */
  readonly sessionsDir: string;
  /** The proxy's upstream fetch (a test's scripted origin). */
  readonly fetch?: typeof fetch;
}

/** A harness the runner runs. */
export interface RunnerHarness {
  /** Who keeps the run's visible record: absent, the adapter; "loop", the adapter loop (AdapterRunSpec.record). */
  readonly record?: "loop";
  /** The harness's adapter for one claim. `extra`: options of the harness's own, passed on as given (a test's stand-in
   *  CLI and scripted SDK). */
  adapter(launch: HarnessLaunch, extra?: Readonly<Record<string, unknown>>): Promise<AgentAdapter>;
}

type ClaudePackage = { claudeAgentAdapter(options: Record<string, unknown>): AgentAdapter };
const CLAUDE_PACKAGE = "@parcha/agentrun-harness-claude";
type CodexPackage = { codexAdapter(options: Record<string, unknown>): AgentAdapter };
const CODEX_PACKAGE = "@parcha/agentrun-harness-codex";

/** Every harness the runner runs, by name. */
export const RUNNER_HARNESSES: Readonly<Record<string, RunnerHarness>> = {
  pi: {
    adapter: async (launch) =>
      piAdapter({
        run: launch.run,
        model: launch.model,
        provider: { api: launch.provider.api ?? "anthropic-messages", origin: launch.provider.origin, credential: launch.provider.credential, ...(launch.provider.headers ? { headers: launch.provider.headers } : {}), ...(launch.provider.auth ? { auth: launch.provider.auth } : {}) },
        ...(launch.price ? { price: launch.price } : {}),
        ...(launch.fetch ? { fetch: launch.fetch } : {}),
      }),
  },
  "claude-agent": {
    record: "loop",
    adapter: async (launch, extra = {}) => {
      const claude = (await import(CLAUDE_PACKAGE)) as ClaudePackage;
      return claude.claudeAgentAdapter({
        model: launch.model,
        provider: { origin: launch.provider.origin, credential: launch.provider.credential, ...(launch.provider.headers ? { headers: launch.provider.headers } : {}) },
        ...(launch.price ? { price: launch.price } : {}),
        ...(launch.fetch ? { fetch: launch.fetch } : {}),
        sessionsDir: launch.sessionsDir,
        ...extra,
      });
    },
  },
  codex: {
    record: "loop",
    adapter: async (launch, extra = {}) => {
      const codex = (await import(CODEX_PACKAGE)) as CodexPackage;
      // Codex's provider is its origin and credential, as serve gives it today (adapters.ts, codexOf): no headers.
      return codex.codexAdapter({
        model: launch.model,
        provider: { origin: launch.provider.origin, credential: launch.provider.credential },
        ...(launch.price ? { price: launch.price } : {}),
        ...(launch.fetch ? { fetch: launch.fetch } : {}),
        sessionsDir: launch.sessionsDir,
        ...extra,
      });
    },
  },
  opencode: {
    record: "loop",
    adapter: async (launch, extra = {}) => {
      // OpenCode's adapter is serve's own (its pinned binary is checked when the adapter is made); loaded when first asked.
      const { openCodeAdapter } = await import("../../harness-opencode/index.js");
      return openCodeAdapter({
        model: launch.model,
        provider: { origin: launch.provider.origin, credential: launch.provider.credential },
        ...(launch.price ? { price: launch.price as never } : {}),
        ...(launch.fetch ? { fetch: launch.fetch } : {}),
        sessionsDir: launch.sessionsDir,
        ...extra,
      });
    },
  },
};

/** The harness the launch names, or undefined when the runner runs none by that name. */
export function resolveHarness(harness: string): RunnerHarness | undefined {
  return Object.prototype.hasOwnProperty.call(RUNNER_HARNESSES, harness) ? RUNNER_HARNESSES[harness] : undefined;
}
