// Codex as an AgentRun harness adapter. Written for AgentRun.
//
// A session is the copied Codex harness (harness.ts) driven over the session's own records (the kernel's openDrive on
// the writer the runner lends, `io.writer`), on a local machine (host/machine.ts): Codex's app-server with its built-in tools off, its
// model behind the session's loopback proxy (@parcha/agentrun-adapters/host), and the host's tools, exactly those `spec.tools` names,
// as its only tools. Every paid request passes the runner's `beforeRequest` first, and its usage comes back through
// `afterRequest`.
//
// The host's skills (`skills`) are the only skills Codex lists to the model: written into the session's CODEX_HOME at the
// start of every drive, where Codex finds a user's skills even in a turn with no environment, and Codex's own bundled
// skills turned off. With no shell, the model reads a skill's files with `read_skill_file`.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { READ_SKILL_FILE, readSkillFileTool, skillProblems, toolSchemaProblems, type HostSkill } from "@parcha/agentrun-adapters";
import type { AdapterEvent, AdapterSession, AgentAdapter, HostTool, SessionIO, SessionSpec, TurnStatus } from "@parcha/agentrun-adapters";
import { abortedOutcome, openDrive, SessionHalt, type Drive, type HostTool as KernelTool } from "@parcha/agentrun-adapters/kernel";
import { pendingSubmissions } from "@parcha/agentrun-adapters/kernel";
import { recoveryNote, transcriptOf } from "@parcha/agentrun-adapters/process";
import { CODEX_VERSION } from "./binary.js";
import { codexSchemaProblems, describedDescription } from "./schema.js";
import { withCheckedBinary } from "./host/sandbox.js";
import { verifyCodex } from "./verify.js";
import { codexHarness, type CodexHarnessOptions } from "./harness.js";
import { type ConfineChild, localMachine, type MachineSeed, sessionDir } from "./host/machine.js";
import { serialWriter, type ModelProxyOptions } from "@parcha/agentrun-adapters/host";

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
  /** The price of a response; null (or no function) records its cost as unknown. */
  price?: ModelProxyOptions["price"];
  /** The most output tokens one request may ask for. Default 32 000. */
  maxOutputTokens?: number;
  /** The model's context window. Default 272 000. */
  contextWindow?: number;
  /** Where sessions keep their private directories when the host lends none (`io.dir`): one per session key. */
  sessionsDir?: string;
  /** The host's skills, which Codex lists to the model by name and description and the model reads with
   *  `read_skill_file`, and no others: never Codex's bundled ones. Checked when the adapter is made (`skillProblems`, the
   *  check the Claude adapter runs). Written into each session's private directory. Default none. */
  skills?: readonly HostSkill[];
  /** Diagnostics. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** For tests: a command that speaks app-server's protocol instead of Codex (needs AGENTRUN_CODEX_STANDIN=1 under a test runner). */
  standIn?: { command: string; args?: string[]; env?: Record<string, string> };
  /** For tests: the fetch the model proxy forwards with. */
  fetch?: typeof fetch;
}

/** The kernel's tool for a host tool: the same name, schema and replay policy; a host's error result is the call's failure.
 *  The call runs as a kernel effect, whose intent is durable in the session's records before `execute` is entered, so a
 *  crash inside a `never` tool is always reported, never repeated. The copied harness's wait for Codex's own `function_call`
 *  line before it runs such a tool is a second guard (the transcript Codex resumes from), not the one that protects it. */
function kernelTool(tool: HostTool): KernelTool {
  return {
    name: tool.name,
    // Codex strips some keywords from the schema its model is given: they are said in plain words in the description
    // (the schema itself is the host's, and every call is checked against it).
    description: describedDescription(tool.description, tool.inputSchema),
    inputSchema: tool.inputSchema,
    replay: tool.replay,
    async execute(input, io) {
      // The effect's step is `tool:<Codex call id>#<attempt>`: the host sees Codex's call id.
      const callId = (io.stepId ?? "").replace(/^tool:/, "").replace(/#\d+$/, "");
      const result = await tool.call(input, { callId, signal: io.signal });
      if (result.isError) throw new Error(result.text);
      return result.text;
    },
  };
}

/** The adapter's event for a harness live event, if it has one. */
function adapterEvent(event: unknown): AdapterEvent | undefined {
  const e = event as { type?: string; delta?: unknown; name?: unknown; callId?: unknown; args?: unknown; isError?: unknown };
  if (e?.type === "text" && typeof e.delta === "string") return { type: "text", delta: e.delta };
  if (e?.type === "tool_start" && typeof e.name === "string") return { type: "tool_start", callId: String(e.callId ?? ""), name: e.name, args: e.args };
  if (e?.type === "tool_end" && typeof e.name === "string") return { type: "tool_end", callId: String(e.callId ?? ""), name: e.name, isError: e.isError === true };
  return undefined;
}

const turnsIn = (drive: Drive) => transcriptOf(drive.state()).filter((r) => r.data?.type === "turn");

/** Where Codex finds a user's skills: `$CODEX_HOME/skills`. It lists those to the model in a turn with no environment
 *  (this adapter's, with the built-ins off), where it lists none of a working directory's `.agents/skills`. */
const SKILLS_DIR = "skills";

/** The skills as the files the session's CODEX_HOME holds (`skills/<name>/<path>`): the machine's seed. */
function skillsSeed(skills: readonly HostSkill[]): MachineSeed {
  return { dir: "codex-home", files: Object.fromEntries(skills.flatMap((skill) => Object.entries(skill.files).map(([path, text]) => [`${SKILLS_DIR}/${skill.name}/${path}`, text]))) };
}

export function codexAdapter(options: CodexAdapterOptions): AgentAdapter {
  // The skills first: a skill Codex would skip or list under another name is the host's to fix, binary or not.
  const skills = options.skills ?? [];
  const skillsWrong = skillProblems(skills);
  if (skillsWrong.length) throw new Error(`agentrun-codex: ${skillsWrong.join("; ")}`);
  const seed = skills.length ? skillsSeed(skills) : undefined;
  // The binary is checked once, here, against the pins: a mismatch or a missing binary is the host's to report, before
  // any run starts (CodexPinMismatch, CodexNotInstalled). A test's stand-in runs no Codex.
  const checked = options.standIn ? undefined : verifyCodex().path;
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
        if (skills.length && tool.name === READ_SKILL_FILE) problems.push(`the tool name ${READ_SKILL_FILE} is the adapter's own when it has skills`);
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
      return problems;
    },
    async open(spec, io) {
      const problems = this.check(spec);
      if (problems.length) throw new Error(`agentrun-codex: ${problems.join("; ")}`);
      const dir = io.dir ?? (options.sessionsDir ? join(options.sessionsDir, createHash("sha256").update(spec.key).digest("hex").slice(0, 32)) : undefined);
      if (!dir) throw new Error("agentrun-codex: a session needs a private directory: the host lends one (io.dir), or pass sessionsDir");

      // With skills the model also reads their files (read_skill_file), from the session's own copy of them.
      const tools: HostTool[] = skills.length ? [...spec.tools, readSkillFileTool(join(sessionDir(dir, "codex-home"), SKILLS_DIR), skills.map((skill) => ({ name: skill.name, files: Object.keys(skill.files) })))] : spec.tools;

      const effort = spec.effort ?? spec.thinking;
      const harnessOptions: CodexHarnessOptions = {
        tools: tools.map(kernelTool),
        builtins: false,
        // Codex's bundled skills (imagegen, skill-installer, ...), which it writes under `$CODEX_HOME/skills/.system` at every
        // start, are off in every session, skills or not: the model is shown the host's skills and no others.
        config: { skills: { bundled: { enabled: false } } },
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
            ...(seed ? { seed } : {}),
            proxy: {
              hooks: io.models,
              tools: tools.map((t) => t.name),
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
        if (mapped) io.onEvent(mapped);
      };
      // Every drive of this session writes through one serialized writer, so a drive opened after an interrupt reads only
      // once the halted drive's last writes are in.
      const writer = serialWriter(io.writer);
      const open = () => openDrive({ writer, signal: io.signal, live });
      let drive = await open();
      const initial = drive.state();
      let state: AdapterSession["state"] = recoveryNote(initial) || pendingSubmissions(initial).length
        ? "open_turn"
        : initial.submissions.length === 0 && turnsIn(drive).length === 0 ? "new" : "idle";

      let running: Promise<{ status: TurnStatus; error?: string }> | undefined;
      let closed = false;
      const run = () => {
        const before = turnsIn(drive).length;
        const current = drive;
        state = "idle";
        running = (async () => {
          let outcome: { status: TurnStatus; error?: string };
          try {
            await harness.drive(current);
            const ended = turnsIn(current).slice(before).at(-1)?.data as { status?: TurnStatus; error?: string } | undefined;
            outcome = ended?.status ? { status: ended.status, ...(ended.error ? { error: ended.error } : {}) } : { status: "failed", error: "the turn ended with no outcome in the session's records" };
          } catch (error) {
            // Stopped by the session or its host: interrupted. Halted by anything else: failed, naming why.
            outcome = current.signal.aborted
              ? abortedOutcome(current.signal, io.signal)
              : { status: "failed", error: String((error as Error)?.message ?? error).slice(0, 500) };
          }
          io.onEvent({ type: "turn_end", status: outcome.status });
          return outcome;
        })();
        return running;
      };
      // A drive that was halted (an interrupt) holds the session no more: the next turn opens a fresh one, on the same
      // writer (the adapter never opens the session itself).
      const ready = async () => {
        if (closed) throw new Error("agentrun-codex: the session is closed");
        if (running) await running;
        if (drive.signal.aborted && !io.signal.aborted) drive = await open();
      };

      return {
        get state() { return state; },
        async send(text) {
          await ready();
          await drive.submit({ id: randomUUID(), kind: "prompt", text });
          void run();
        },
        async recover() {
          if (state !== "open_turn") throw new Error("agentrun-codex: there is no turn to recover");
          await ready();
          void run();
        },
        async turnEnd() {
          if (!running) throw new Error("agentrun-codex: no turn is in flight");
          return running;
        },
        async interrupt() {
          drive.halt?.(new SessionHalt("interrupted"));
          await running?.catch(() => {});
        },
        async close() {
          if (closed) return;
          closed = true;
          drive.halt?.(new SessionHalt("closed"));
          await running?.catch(() => {});
        },
      };
    },
  };
}
