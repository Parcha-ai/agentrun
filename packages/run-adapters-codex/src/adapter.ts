// Codex as an AgentRun harness adapter. Written for AgentRun.
//
// A session is the copied Codex harness (harness.ts) driven over the session's own records (the kernel's openDrive on
// the writer the runner lends, `io.writer`), on a local machine (host/machine.ts): Codex's app-server with its built-in tools off, its
// model behind the session's loopback proxy (@parcha/agentrun-kernel/host), and the host's tools, exactly those `spec.tools` names,
// as its only tools. Every paid request passes the runner's `beforeRequest` first, and its usage comes back through
// `afterRequest`.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CallsInFlight, openAdapterSession, toolSchemaProblems } from "@parcha/agentrun-kernel";
import type { AdapterEvent, AgentAdapter, HostTool, SessionIO, SessionSpec } from "@parcha/agentrun-kernel";
import type { HostTool as KernelTool } from "@parcha/agentrun-kernel/kernel";
import { CODEX_VERSION } from "./binary.js";
import { readCodeModeModels } from "./code-mode.js";
import { codexSchemaProblems, describedDescription } from "./schema.js";
import { withCheckedBinary } from "./host/sandbox.js";
import { verifyCodex } from "./verify.js";
import { codexHarness, type CodexHarnessOptions } from "./harness.js";
import { type ConfineChild, localMachine, type MachineBox } from "./host/machine.js";
import type { ModelProxyOptions } from "@parcha/agentrun-kernel/host";

/** A name app-server accepts for a dynamic tool. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface CodexProvider {
  /** The provider's origin (`https://api.openai.com`): the proxy forwards to its `/v1/responses` only. */
  origin: string;
  /** The provider key, read per request in this process. It never reaches Codex's process. */
  credential: () => Promise<string> | string;
}

export interface CodexAdapterOptions {
  /** The provider's model id, or one per tier (`default` when a node names none). */
  model: string | { default: string; fast?: string; strong?: string };
  provider: CodexProvider;
  /** Start Codex under the host's confinement (its own `confine()`, a `setpriv --no-new-privs` prefix, say). It may only
   *  add in front of the pinned binary and its arguments, and never touches its environment. */
  confine?: ConfineChild;
  /** The host's box for Codex (@parcha/agentrun-kernel/host's MachineBox), or `unsandboxed`, the operator's word that
   *  there is none. Absent: the host gives none, and a session with Codex's own tools on fails with a named error. */
  box?: MachineBox | "unsandboxed";
  /** The price of a response; null (or no function) records its cost as unknown. */
  price?: ModelProxyOptions["price"];
  /** The most output tokens one request may ask for. Default 32 000. */
  maxOutputTokens?: number;
  /** The model's context window. Default 272 000. */
  contextWindow?: number;
  /** Where sessions keep their private directories when the host lends none (`io.dir`): one per session key. */
  sessionsDir?: string;
  /** Diagnostics. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** For tests: a command that speaks app-server's protocol instead of Codex (needs AGENTRUN_CODEX_STANDIN=1 under a test runner). */
  standIn?: { command: string; args?: string[]; env?: Record<string, string> };
  /** For tests: the fetch the model proxy forwards with. */
  fetch?: typeof fetch;
  /** TEST-ONLY (the stand-in's guard: AGENTRUN_CODEX_STANDIN=1 under a test runner, never in production; passed anywhere
   *  else, the adapter throws when it is made): how the code-mode models are read from the checked binary, in place of its
   *  own catalog. It must never switch off the refusal of code-mode models in a host. */
  readCodeModeModels?: (binary: string) => ReadonlySet<string>;
}

/** The kernel's tool for a host tool: the same name, schema and replay policy; a host's error result is the call's failure.
 *  The call runs as a kernel effect, whose intent is durable in the session's records before `execute` is entered, so a
 *  crash inside a `never` tool is always reported, never repeated. The copied harness's wait for Codex's own `function_call`
 *  line before it runs such a tool is a second guard (the transcript Codex resumes from), not the one that protects it. */
function kernelTool(tool: HostTool, io: SessionIO, calls: CallsInFlight): KernelTool {
  return {
    name: tool.name,
    // Codex strips some keywords from the schema its model is given: they are said in plain words in the description
    // (the schema itself is the host's, and every call is checked against it).
    description: describedDescription(tool.description, tool.inputSchema),
    inputSchema: tool.inputSchema,
    replay: tool.replay,
    async execute(input, effect) {
      // The effect's step is `tool:<Codex call id>#<attempt>`: the host sees Codex's call id.
      const callId = (effect.stepId ?? "").replace(/^tool:/, "").replace(/#\d+$/, "");
      // In flight, and past the pause's check, before the host hears of it: a pause the host starts on this tool_start
      // waits for this call rather than refusing it.
      calls.begin(callId);
      // A guard: a call begun during a pause is not run.
      if (calls.draining) throw new Error(`${tool.name} was not run: the session is pausing`);
      io.onEvent({ type: "tool_start", callId, name: tool.name, args: input });
      const result = await tool.call(input, { callId, signal: effect.signal });
      if (result.isError) throw new Error(result.text);
      return result.text;
    },
  };
}

/** The adapter's event for a harness live event, if it has one. */
function adapterEvent(event: unknown): AdapterEvent | undefined {
  const e = event as { type?: string; delta?: unknown; name?: unknown; callId?: unknown; args?: unknown; isError?: unknown };
  if (e?.type === "text" && typeof e.delta === "string") return { type: "text", delta: e.delta };
  // A host tool's tool_start is the adapter's own (kernelTool), sent once the call is counted in flight: the bridge's, sent
  // before that, is not passed on, so a pause the host starts on it never refuses the call.
  if (e?.type === "tool_end" && typeof e.name === "string") return { type: "tool_end", callId: String(e.callId ?? ""), name: e.name, isError: e.isError === true };
  return undefined;
}

/** The test-only options' guard, the stand-in's: only a test run with AGENTRUN_CODEX_STANDIN=1, never in production. */
function testOnly(name: string): void {
  if (process.env.AGENTRUN_CODEX_STANDIN !== "1") throw new TypeError(`agentrun-harness-codex: ${name} is test-only and needs AGENTRUN_CODEX_STANDIN=1`);
  if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== "test") throw new TypeError(`agentrun-harness-codex: ${name} is test-only and runs only under a test runner`);
  if (process.env.NODE_ENV === "production") throw new TypeError(`agentrun-harness-codex: ${name} is test-only and is refused in production`);
}

export function codexAdapter(options: CodexAdapterOptions): AgentAdapter {
  if (options.readCodeModeModels) testOnly("readCodeModeModels");
  // The binary is checked once, here, against the pins: a mismatch or a missing binary is the host's to report, before
  // any run starts (CodexPinMismatch, CodexNotInstalled). A test's stand-in runs no Codex.
  const checked = options.standIn ? undefined : verifyCodex().path;
  // The models the binary runs in code mode, read from its own catalog the first time a session is checked.
  let codeMode: ReadonlySet<string> | undefined;
  const modelFor = (spec: SessionSpec): string => {
    if (typeof options.model === "string") return options.model;
    return (spec.tier && spec.tier !== "default" ? options.model[spec.tier] : undefined) ?? options.model.default;
  };

  return {
    id: "codex",
    version: CODEX_VERSION,
    capabilities: () => ({ fork: false }),
    check(spec) {
      const problems: string[] = [];
      if (spec.context === "fork") problems.push("Codex sessions cannot fork another session's transcript; declare context: \"fresh\"");
      const seen = new Set<string>();
      for (const tool of spec.tools) {
        if (!TOOL_NAME.test(tool.name)) problems.push(`the tool name ${JSON.stringify(tool.name.slice(0, 80))} is not one Codex accepts (letters, digits, _ and -, at most 64)`);
        if (seen.has(tool.name)) problems.push(`the tool ${tool.name} is given twice`);
        seen.add(tool.name);
        // What no harness takes (an object root, valid 2020-12, no remote $ref), then what Codex would drop or retype in
        // the tool's schema: refused here, by name, not found out mid-turn. A place the first already refused is not
        // refused again by the second.
        // Nothing in it may throw: a tool whose schema cannot be checked is a problem at "/", naming the tool.
        try {
          const shared = toolSchemaProblems(tool.name, tool.inputSchema);
          // A schema the shared check refuses as a whole (its root, or that it is not JSON: a cycle only code can build)
          // is not walked again: Codex's rules would never reach the end of a cycle.
          const wholly = shared.some((problem) => problem.startsWith(`${tool.name}: /:`));
          const refusedAt = new Set(shared.map((problem) => /^[^:]*: (\S+):/.exec(problem)?.[1]));
          problems.push(...shared, ...(wholly ? [] : codexSchemaProblems(tool.name, tool.inputSchema).filter((problem) => !refusedAt.has(/^[^:]*: (\S+):/.exec(problem)?.[1]))));
        } catch (error) {
          problems.push(`${tool.name}: /: the tool's schema could not be checked (${String((error as Error)?.message ?? error).slice(0, 120)})`);
        }
      }
      if (checked !== undefined) {
        codeMode ??= (options.readCodeModeModels ?? readCodeModeModels)(checked);
        const model = modelFor(spec);
        if (codeMode.has(model)) problems.push(`the model ${JSON.stringify(model.slice(0, 80))} runs tools in code mode, which this adapter does not support yet; use a model that calls tools as functions`);
      }
      return problems;
    },
    async open(spec, io) {
      const problems = this.check(spec);
      if (problems.length) throw new Error(`agentrun-harness-codex: ${problems.join("; ")}`);
      const dir = io.dir ?? (options.sessionsDir ? join(options.sessionsDir, createHash("sha256").update(spec.key).digest("hex").slice(0, 32)) : undefined);
      if (!dir) throw new Error("agentrun-harness-codex: a session needs a private directory: the host lends one (io.dir), or pass sessionsDir");

      const calls = new CallsInFlight();
      const effort = spec.effort ?? spec.thinking;
      const harnessOptions: CodexHarnessOptions = {
        tools: spec.tools.map((tool) => kernelTool(tool, io, calls)),
        builtins: false,
        model: modelFor(spec),
        ...(spec.system.length ? { instructions: spec.system.join("\n\n") } : {}),
        ...(effort ? { effort } : {}),
        credential: async () => options.provider.credential(),
        gatewayUrl: options.provider.origin,
        contextWindow: options.contextWindow ?? 272_000,
        ...(options.log ? { log: options.log } : {}),
        ...(options.standIn ? { test: { command: options.standIn.command, args: options.standIn.args ?? [] } } : {}),
        machine: {
          ...(options.standIn?.env ? { env: options.standIn.env } : {}),
          acquire: localMachine({
            dir,
            ...(options.confine ? { confine: options.confine } : {}),
            ...(options.box ? { box: options.box } : {}),
            proxy: {
              hooks: io.models,
              tools: spec.tools.map((t) => t.name),
              ...(options.log ? { log: options.log } : {}),
              ...(options.price ? { price: options.price } : {}),
              ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
              ...(options.fetch ? { fetch: options.fetch } : {}),
            },
          }),
        },
      };
      const harness = checked === undefined ? codexHarness(harnessOptions) : withCheckedBinary(checked, () => codexHarness(harnessOptions));

      const live = (event: unknown) => {
        const mapped = adapterEvent(event);
        if (!mapped) return;
        // A call's tool_end comes once its outcome is in the session's records: it is no longer in flight.
        if (mapped.type === "tool_end") calls.end(mapped.callId);
        io.onEvent(mapped);
      };
      return openAdapterSession({ name: "agentrun-harness-codex", io, drive: (drive) => harness.drive(drive), live, calls });
    },
  };
}
