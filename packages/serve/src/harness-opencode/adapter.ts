// OpenCode as an AgentRun harness adapter. Written for AgentRun.
//
// A session is the OpenCode harness (harness.ts) driven over the session's own records (the kernel's openDrive on the
// writer the runner lends, `io.writer`): the pinned `opencode serve`, one per drive, with every OpenCode tool off, its
// model behind the session's loopback proxy (@parcha/agentrun-kernel/host) and the host's tools, exactly those `spec.tools`
// names, as its only tools, served over the adapter's own MCP server. Every paid request passes the runner's
// `beforeRequest` first, and its usage comes back through `afterRequest`.
//
// The host's skills (`skills`) are listed in the session's instructions by name and description, and the model reads a
// skill's files with `read_skill_file`: OpenCode's own skills are off.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { READ_SKILL_FILE, readSkillFileTool, skillProblems, toolSchemaProblems, type HostSkill } from "@parcha/agentrun-kernel";
import type { AdapterEvent, AdapterSession, AgentAdapter, HostTool, SessionSpec, TurnStatus } from "@parcha/agentrun-kernel";
import { abortedOutcome, openDrive, pendingSubmissions, SessionHalt, type Drive, type HostTool as KernelTool } from "@parcha/agentrun-kernel/kernel";
import { recoveryNote, settleTurn, transcriptOf } from "@parcha/agentrun-kernel/process";
import { serialWriter, startModelProxy, type ModelProxyOptions } from "@parcha/agentrun-kernel/host";
import { OPENCODE_VERSION } from "./binary.js";
import { openCodeHarness, sentSubmissions, type DriveControl } from "./harness.js";
import { openCodePolicy, TOOL_PREFIX } from "./host/policy.js";
import type { ConfineChild } from "./host/server.js";
import { verifyOpenCode } from "./verify.js";

/** A name OpenCode keeps whole for an MCP tool (it turns anything else into `_`), short enough that `hands_<name>` is a
 *  function name the Responses API takes (at most 64). */
const TOOL_NAME = new RegExp(`^[A-Za-z0-9_-]{1,${64 - TOOL_PREFIX.length}}$`);

/** How long a stop waits for OpenCode to end the turn itself before the drive is halted. */
const INTERRUPT_MS = 3_000;

/** `opencode serve` on this machine only, on a port of its choosing (its listening line says which). */
const SERVE_ARGS = ["serve", "--hostname", "127.0.0.1", "--port", "0"]; // key-gate: loopback-rule opencode serve listens on 127.0.0.1 only, on a port of its choosing

export interface OpenCodeProvider {
  /** The provider's origin (`https://api.openai.com`, or a gateway's base): the proxy forwards to its `/v1/responses` only. */
  origin: string;
  /** The provider key, read per request in this process. It never reaches OpenCode's process. */
  credential: () => Promise<string> | string;
}

export interface OpenCodeAdapterOptions {
  /** The provider's model id, or one per tier (`default` when a node names none). */
  model: string | { default: string; fast?: string; strong?: string };
  provider: OpenCodeProvider;
  /** Start OpenCode under the host's confinement (a `setpriv --no-new-privs` prefix, say). It may only add in front of
   *  the pinned binary and its arguments, and never touches its environment. */
  confine?: ConfineChild;
  /** The price of a response; null (or no function) records its cost as unknown. */
  price?: ModelProxyOptions["price"];
  /** The most output tokens one request may ask for. Default 32 000. */
  maxOutputTokens?: number;
  /** The model's context window. Default 272 000. */
  contextWindow?: number;
  /** Where sessions keep their private directories when the host lends none (`io.dir`): one per session key. */
  sessionsDir?: string;
  /** The host's skills, listed to the model by name and description and read with `read_skill_file`, and no others. */
  skills?: readonly HostSkill[];
  /** How long a drive waits for OpenCode's event stream to open, on each of its three tries. Default 10 s. */
  eventConnectMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** For tests: a command that speaks `opencode serve`'s protocol instead of OpenCode (needs AGENTRUN_OPENCODE_STANDIN=1
   *  under a test runner). */
  standIn?: { command: string; args?: string[]; env?: Record<string, string> };
  /** For tests: the fetch the model proxy forwards with. */
  fetch?: typeof fetch;
}

/** The kernel's tool for a host tool: the same name, schema and replay policy; a host's error result is the call's
 *  failure. The call runs as a kernel effect, whose intent is durable in the session's records before `execute` is
 *  entered, so a crash inside a `never` tool is always reported, never repeated. */
function kernelTool(tool: HostTool): KernelTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    replay: tool.replay,
    async execute(input, io) {
      // The effect's step is `tool:<the model's call id>#<attempt>`: the host sees the model's call id.
      const callId = (io.stepId ?? "").replace(/^tool:/, "").replace(/#\d+$/, "");
      const result = await tool.call(input, { callId, signal: io.signal });
      if (result.isError) throw new Error(result.text);
      return result.images?.length ? { text: result.text, images: result.images } : result.text;
    },
  };
}

/** The adapter's event for a harness live event, if it has one: exactly the four a host reads. A call's `tool_end`
 *  carries the result text the log recorded; names are the host's own (the bridge is keyed by them). */
function adapterEvent(event: unknown): AdapterEvent | undefined {
  const e = event as { type?: string; delta?: unknown; name?: unknown; callId?: unknown; args?: unknown; isError?: unknown; result?: unknown; truncated?: unknown };
  if (e?.type === "text" && typeof e.delta === "string") return { type: "text", delta: e.delta };
  if (e?.type === "tool_start" && typeof e.name === "string") return { type: "tool_start", callId: String(e.callId ?? ""), name: e.name, args: e.args };
  if (e?.type === "tool_end" && typeof e.name === "string") return { type: "tool_end", callId: String(e.callId ?? ""), name: e.name, isError: e.isError === true, ...(typeof e.result === "string" ? { result: e.result } : {}), ...(e.truncated === true ? { truncated: true as const } : {}) };
  return undefined;
}

const turnsIn = (drive: Drive) => transcriptOf(drive.state()).filter((r) => r.data?.type === "turn");

/** The skills as the instructions list them: each by name and description, read with `read_skill_file`. */
function skillsNote(skills: readonly HostSkill[]): string {
  const lines = ["You have these skills. Read a skill's SKILL.md with read_skill_file before you use it, and the files it names the same way."];
  for (const skill of skills) {
    const head = /^---\n([\s\S]*?)\n---/.exec(skill.files["SKILL.md"] ?? "")?.[1] ?? "";
    const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    lines.push(`- ${skill.name}: ${description}`);
  }
  return lines.join("\n");
}

export function openCodeAdapter(options: OpenCodeAdapterOptions): AgentAdapter {
  const skills = options.skills ?? [];
  const skillsWrong = skillProblems(skills);
  if (skillsWrong.length) throw new Error(`opencode: ${skillsWrong.join("; ")}`);
  // The binary is checked once, here, against the pins: a mismatch or a missing binary is the host's to report, before
  // any run starts (OpenCodePinMismatch, OpenCodeNotInstalled). A test's stand-in runs no OpenCode.
  if (options.standIn) {
    if (process.env.AGENTRUN_OPENCODE_STANDIN !== "1") throw new TypeError("opencode: a stand-in for OpenCode needs AGENTRUN_OPENCODE_STANDIN=1");
    if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== "test") throw new TypeError("opencode: a stand-in for OpenCode runs only under a test runner");
  }
  const checked = options.standIn ? undefined : verifyOpenCode().path;
  const modelFor = (spec: SessionSpec): string => {
    if (typeof options.model === "string") return options.model;
    return (spec.tier && spec.tier !== "default" ? options.model[spec.tier] : undefined) ?? options.model.default;
  };

  return {
    id: "opencode",
    version: OPENCODE_VERSION,
    capabilities: () => ({ fork: false }),
    check(spec) {
      const problems: string[] = [];
      if (spec.context === "fork") problems.push("OpenCode sessions cannot fork another session's transcript; declare context: \"fresh\"");
      const seen = new Set<string>();
      for (const tool of spec.tools) {
        if (!TOOL_NAME.test(tool.name)) problems.push(`the tool name ${JSON.stringify(tool.name.slice(0, 80))} is not one OpenCode keeps whole (letters, digits, _ and -, at most ${64 - TOOL_PREFIX.length})`);
        if (seen.has(tool.name)) problems.push(`the tool ${tool.name} is given twice`);
        if (skills.length && tool.name === READ_SKILL_FILE) problems.push(`the tool name ${READ_SKILL_FILE} is the adapter's own when it has skills`);
        seen.add(tool.name);
        try {
          problems.push(...toolSchemaProblems(tool.name, tool.inputSchema));
        } catch (error) {
          problems.push(`${tool.name}: /: the tool's schema could not be checked (${String((error as Error)?.message ?? error).slice(0, 120)})`);
        }
      }
      return problems;
    },
    async open(spec, io) {
      const problems = this.check(spec);
      if (problems.length) throw new Error(`opencode: ${problems.join("; ")}`);
      const dir = io.dir ?? (options.sessionsDir ? join(options.sessionsDir, createHash("sha256").update(spec.key).digest("hex").slice(0, 32)) : undefined);
      if (!dir) throw new Error("opencode: a session needs a private directory: the host lends one (io.dir), or pass sessionsDir");

      // With skills the model also reads their files (read_skill_file), from the session's own copy of them.
      const skillsDir = join(dir, "skills");
      const tools: HostTool[] = skills.length ? [...spec.tools, readSkillFileTool(skillsDir, skills.map((skill) => ({ name: skill.name, files: Object.keys(skill.files) })))] : spec.tools;
      if (skills.length) {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        const { dirname } = await import("node:path");
        for (const skill of skills) {
          for (const [path, text] of Object.entries(skill.files)) {
            const file = join(skillsDir, skill.name, path);
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
            writeFileSync(file, text, { mode: 0o600 });
          }
        }
      }
      const instructions = [...spec.system, ...(skills.length ? [skillsNote(skills)] : [])].join("\n\n");
      const effort = spec.effort ?? spec.thinking;
      let control: DriveControl | undefined;
      const harness = openCodeHarness({
        tools: tools.map(kernelTool),
        model: modelFor(spec),
        ...(instructions ? { instructions } : {}),
        ...(effort ? { effort: String(effort) } : {}),
        dir,
        ...(io.cwd ? { cwd: io.cwd } : {}),
        // A stand-in is given the same server arguments as OpenCode, so it listens where OpenCode would.
        command: options.standIn ? { command: options.standIn.command, args: [...(options.standIn.args ?? []), ...SERVE_ARGS], ...(options.standIn.env ? { env: options.standIn.env } : {}) } : { command: checked!, args: [...SERVE_ARGS] },
        ...(options.confine ? { confine: options.confine } : {}),
        provider: options.provider,
        hooks: io.models as never,
        ...(options.price ? { price: options.price } : {}),
        ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        contextWindow: options.contextWindow ?? 272_000,
        ...(options.eventConnectMs ? { eventConnectMs: options.eventConnectMs } : {}),
        ...(options.log ? { log: options.log } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }, (c) => void (control = c));

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
      // A turn is open while the session holds input no turn placed, or a turn with no end (its recovery note).
      const holdsTurn = (folded: typeof initial) => Boolean(recoveryNote(folded)) || pendingSubmissions(folded).length > 0;
      let state: AdapterSession["state"] = holdsTurn(initial)
        ? "open_turn"
        : initial.submissions.length === 0 && turnsIn(drive).length === 0 ? "new" : "idle";

      let running: Promise<{ status: TurnStatus; error?: string }> | undefined;
      let closed = false;
      // Whether this session's interrupt stopped the turn in flight (its end is not written: the turn stays open).
      let interrupted = false;
      const run = () => {
        const before = turnsIn(drive).length;
        const current = drive;
        state = "idle";
        interrupted = false;
        running = (async () => {
          let outcome: { status: TurnStatus; error?: string };
          try {
            await harness.drive(current);
            const ended = turnsIn(current).slice(before).at(-1)?.data as { status?: TurnStatus; error?: string } | undefined;
            // A turn its interrupt stopped has no end in the records (it stays open): interrupted.
            outcome = ended?.status ? { status: ended.status, ...(ended.error ? { error: ended.error } : {}) } : interrupted ? { status: "interrupted" } : { status: "failed", error: "the turn ended with no outcome in the session's records" };
          } catch (error) {
            // Stopped by the session or its host: interrupted. Halted by anything else: failed, naming why.
            outcome = current.signal.aborted
              ? abortedOutcome(current.signal, io.signal)
              : { status: "failed", error: String((error as Error)?.message ?? error).slice(0, 500) };
            // A stop that landed before this turn ran (while send() was still recording its prompt) found no turn to stop,
            // and reads the session as it was: the turn is open now, its prompt pending, so it reads open_turn (#1565, as
            // codex's adapter does).
            if (current.signal.aborted) state = holdsTurn(current.state()) ? "open_turn" : "idle";
          }
          io.onEvent({ type: "turn_end", status: outcome.status });
          return outcome;
        })();
        return running;
      };
      // A drive that was halted holds the session no more: the next turn opens a fresh one, on the same writer.
      const ready = async () => {
        if (closed) throw new Error("opencode: the session is closed");
        if (running) await running;
        if (drive.signal.aborted && !io.signal.aborted) drive = await open();
      };

      // The session's host port (AdapterSession.port): the host's own requests beside OpenCode's (a learned workflow's
      // node) on the session's route, built from the drive proxy's own pieces (the same policy, origin, credential, price
      // and the session's booking, io.models), on a listener the session holds: a drive's proxy closes with its drive, and
      // an approved call runs before any turn. Side keys only; its policy object is its own. Closed with the session.
      // Started once the session's drive is open, the last step that can fail: an open that fails leaves no listener.
      const hostPort = await startModelProxy({
        policy: openCodePolicy({ model: modelFor(spec), tools: [], ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}) }),
        hooks: io.models as never,
        model: modelFor(spec),
        origin: options.provider.origin,
        credential: async () => (await options.provider.credential()) ?? "",
        ...(options.price ? { price: options.price } : {}),
        ...(options.log ? { log: options.log } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }, randomBytes(32).toString("base64url"));
      let hostClosed = false;
      const closeHost = async () => {
        if (hostClosed) return;
        hostClosed = true;
        await hostPort.close().catch(() => {});
      };
      io.signal.addEventListener("abort", () => void closeHost(), { once: true });
      if (io.signal.aborted) await closeHost();
      return {
        get state() { return state; },
        async send(text) {
          await ready();
          await drive.submit({ id: randomUUID(), kind: "prompt", text });
          void run();
        },
        async recover() {
          if (state !== "open_turn") throw new Error("opencode: there is no turn to recover");
          await ready();
          void run();
        },
        async settleOpenTurn(options = {}) {
          if (state !== "open_turn") throw new Error("opencode: there is no turn to settle");
          await ready();
          // The turn's end in the session's own transcript, as a turn that ends writes it: the next open finds no open turn,
          // and the next turn carries no recovery of this one. Nothing is sent, and OpenCode is not started. A prompt the turn
          // placed and OpenCode was never sent (no send mark: the stop came between the two) is carried into the next
          // message, as an unplaced one is; a follow-up's own is not.
          const folded = drive.state();
          const sent = sentSubmissions(folded);
          const unsent = (recoveryNote(folded)?.turn.placed ?? []).filter((id) => !sent.has(id));
          await settleTurn(drive, { unsent, ...(options.opening === undefined ? {} : { host: options.opening }) });
          state = "idle";
        },
        async turnEnd() {
          if (!running) throw new Error("opencode: no turn is in flight");
          return running;
        },
        async interrupt() {
          // OpenCode is asked to end the turn (it stops spending), and no end is written for it, as codex's interrupt
          // writes none: the turn stays open, its host settles it (a person's stop), or the next process resumes it (the
          // server's own stop, #1578). If OpenCode does not end it within INTERRUPT_MS, the drive is halted, the same.
          interrupted = true;
          const stopped = control ? await control.interrupt(INTERRUPT_MS).catch(() => false) : false;
          if (!stopped) drive.halt?.(new SessionHalt("interrupted"));
          await running?.catch(() => {});
          // A turn the halt stopped is still open in the session (a halt writes no end, and a prompt it stopped before the
          // drive placed it is still pending): open_turn, so a host that is done with it settles it here.
          if (holdsTurn(drive.state())) state = "open_turn";
        },
        async close() {
          if (closed) return;
          closed = true;
          drive.halt?.(new SessionHalt("closed"));
          await running?.catch(() => {});
          await closeHost();
        },
        // The session's one model route, for the host's own request beside OpenCode's: the session's host port, which
        // never restarts once closed.
        port: (label: string) => (closed || hostClosed ? undefined : { url: `${hostPort.url}`, key: hostPort.sideKey(label), model: modelFor(spec), api: "openai-responses" as const }),
      };
    },
  };
}
