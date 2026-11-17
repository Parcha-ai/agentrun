// Any ACP agent as an AgentRun harness adapter, from its recipe. Written for AgentRun.
//
// A session is the ACP harness (harness.ts) driven over the session's own records (the kernel's openDrive on the writer
// the runner lends, `io.writer`): the agent over stdio in a private HOME, the host's tools, exactly those `spec.tools`
// names, as one loopback MCP server, and each permission request for a tool of the agent's own through the host's gate.
// Its model is the agent's: a plan-billed agent's requests never reach the host, so the adapter bounds the run itself
// (the recipe's maxTurns and maxToolCalls); a proxy-billed one's go through the host's proxy (the `proxy` option, S3).
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { toolSchemaProblems } from "@parcha/agentrun-kernel";
import type { AdapterEvent, AdapterSession, AgentAdapter, GateCall, TurnStatus } from "@parcha/agentrun-kernel";
import { abortedOutcome, openDrive, pendingSubmissions, SessionHalt, type Drive } from "@parcha/agentrun-kernel/kernel";
import { bridgeTool, recoveryNote, settleTurn, transcriptOf } from "@parcha/agentrun-kernel/process";
import { serialWriter, type ParentWatch } from "@parcha/agentrun-kernel/host";
import { acpHarness, sentSubmissions, type DriveControl } from "./harness.js";
import { recipeProblems, type AcpRecipe } from "./recipe.js";
import type { ConfineChild } from "./host/child.js";

/** A tool name every ACP agent we know keeps whole in its MCP client. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** How long a stop waits for the agent to end the turn itself (session/cancel) before the drive is halted. */
const INTERRUPT_MS = 3_000;

export interface AcpAdapterOptions {
  /** The agent: how to start it, what it declares, where it keeps its sessions, who bills its model. */
  recipe: AcpRecipe;
  /** Where sessions keep their private directories when the host lends none (`io.dir`): one per session key. */
  sessionsDir?: string;
  /** Start the agent under the host's confinement (a `setpriv --no-new-privs` prefix, say). */
  confine?: ConfineChild;
  parentWatch?: ParentWatch;
  /** The environment the child's allowlist (PATH, LANG, TZ) reads. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Proxy billing: what each agent process gets to reach the host's model proxy, closed with it. Required for a recipe
   *  billed `proxy`; the proxy itself is the host's (S3). */
  proxy?: () => Promise<{ env: Record<string, string>; close(): Promise<void> }>;
  /** How long an MCP call waits for the agent's tool_call that announces it. Default 10 s. */
  callIdWaitMs?: number;
  /** How long the agent may take to start and open its session. Default 60 s. */
  startMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** The adapter's event for a harness live event, if it has one. */
function adapterEvent(event: unknown): AdapterEvent | undefined {
  const e = event as { type?: string; delta?: unknown; name?: unknown; callId?: unknown; args?: unknown; isError?: unknown; result?: unknown; truncated?: unknown; parent?: unknown };
  if (e?.type === "text" && typeof e.delta === "string") return { type: "text", delta: e.delta };
  if (e?.type === "tool_start" && typeof e.name === "string") return { type: "tool_start", callId: String(e.callId ?? ""), name: e.name, args: e.args, ...(typeof e.parent === "string" ? { parent: e.parent } : {}) };
  if (e?.type === "tool_end" && typeof e.name === "string") return { type: "tool_end", callId: String(e.callId ?? ""), name: e.name, isError: e.isError === true, ...(typeof e.result === "string" ? { result: e.result } : {}), ...(e.truncated === true ? { truncated: true as const } : {}) };
  return undefined;
}

const turnsIn = (drive: Drive) => transcriptOf(drive.state()).filter((r) => r.data?.type === "turn");

/** The ACP agent `options.recipe` names, as a harness adapter under the recipe's id. */
export function acpAdapter(options: AcpAdapterOptions): AgentAdapter {
  const recipe = options.recipe;
  const problems = recipeProblems(recipe);
  if (problems.length) throw new Error(`acp: the recipe ${JSON.stringify(recipe?.id ?? "")} cannot run: ${problems.join("; ")}`);
  if (recipe.billing.kind === "proxy" && !options.proxy) throw new Error(`acp: the recipe ${recipe.id} is billed through the host's proxy, and the adapter was given no proxy option`);
  const label = recipe.label ?? recipe.id;

  return {
    id: recipe.id,
    check(spec) {
      const problems: string[] = [];
      if (spec.context === "fork") problems.push(`${label} sessions cannot fork another session's transcript; declare context: "fresh"`);
      const seen = new Set<string>();
      for (const tool of spec.tools) {
        if (!TOOL_NAME.test(tool.name)) problems.push(`the tool name ${JSON.stringify(tool.name.slice(0, 80))} is not one an MCP client keeps whole (letters, digits, _ and -, at most 64)`);
        if (seen.has(tool.name)) problems.push(`the tool ${tool.name} is given twice`);
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
      if (problems.length) throw new Error(`acp: ${problems.join("; ")}`);
      const dir = io.dir ?? (options.sessionsDir ? join(options.sessionsDir, createHash("sha256").update(spec.key).digest("hex").slice(0, 32)) : undefined);
      if (!dir) throw new Error("acp: a session needs a private directory: the host lends one (io.dir), or pass sessionsDir");
      const instructions = spec.system.join("\n\n");
      let control: DriveControl | undefined;
      const harness = acpHarness({
        recipe,
        tools: spec.tools.map((tool) => bridgeTool(tool)),
        ...(instructions ? { instructions } : {}),
        dir,
        ...(io.cwd ? { cwd: io.cwd } : {}),
        ...(options.confine ? { confine: options.confine } : {}),
        ...(options.parentWatch ? { parentWatch: options.parentWatch } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.proxy ? { proxy: options.proxy } : {}),
        ...(options.callIdWaitMs !== undefined ? { callIdWaitMs: options.callIdWaitMs } : {}),
        ...(options.startMs !== undefined ? { startMs: options.startMs } : {}),
        ...(options.log ? { log: options.log } : {}),
        // The host's gate: asked by the kernel's tool bridge for our tools, and by the harness for the agent's own.
        ...(io.gate ? { gate: (call: GateCall) => io.gate!(call) } : {}),
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
      let state: AdapterSession["state"] = holdsTurn(initial) ? "open_turn" : initial.submissions.length === 0 && turnsIn(drive).length === 0 ? "new" : "idle";

      let running: Promise<{ status: TurnStatus; error?: string }> | undefined;
      let closed = false;
      let interrupted = false;
      const run = () => {
        const before = turnsIn(drive).length;
        const current = drive;
        state = "idle";
        interrupted = false;
        running = (async () => {
          let outcome: { status: TurnStatus; error?: string };
          let cut: { stopReason: "length" } | undefined;
          try {
            await harness.drive(current);
            const ended = turnsIn(current).slice(before).at(-1)?.data as { status?: TurnStatus; error?: string; stopReason?: unknown } | undefined;
            if (ended?.stopReason === "length") cut = { stopReason: "length" };
            outcome = ended?.status ? { status: ended.status, ...(ended.error ? { error: ended.error } : {}) } : interrupted ? { status: "interrupted" } : { status: "failed", error: "the turn ended with no outcome in the session's records" };
          } catch (error) {
            // Stopped by the session or its host: interrupted. Halted by anything else: failed, naming why.
            outcome = current.signal.aborted ? abortedOutcome(current.signal, io.signal) : { status: "failed", error: String((error as Error)?.message ?? error).slice(0, 500) };
            if (current.signal.aborted) state = holdsTurn(current.state()) ? "open_turn" : "idle";
          }
          io.onEvent({ type: "turn_end", status: outcome.status, ...(cut && outcome.status === "completed" ? cut : {}) });
          return outcome;
        })();
        return running;
      };
      // A drive that was halted holds the session no more: the next turn opens a fresh one, on the same writer.
      const ready = async () => {
        if (closed) throw new Error("acp: the session is closed");
        if (running) await running;
        if (drive.signal.aborted && !io.signal.aborted) drive = await open();
      };
      return {
        get state() {
          return state;
        },
        async send(text) {
          await ready();
          // A submission of its own every time, as every process adapter's: the host's message id names its row, and a
          // message sent again after a runner was lost is a new turn of the session's, never folded into the one placed.
          await drive.submit({ id: randomUUID(), kind: "prompt", text });
          void run();
        },
        async recover() {
          if (state !== "open_turn") throw new Error("acp: there is no turn to recover");
          await ready();
          void run();
        },
        async settleOpenTurn(settle = {}) {
          if (state !== "open_turn") throw new Error("acp: there is no turn to settle");
          await ready();
          // The turn's end in the session's own transcript: nothing is sent, the agent is not started. A prompt the turn
          // placed and never sent (no send mark) is carried into the next message.
          const folded = drive.state();
          const sent = sentSubmissions(folded);
          const unsent = (recoveryNote(folded)?.turn.placed ?? []).filter((id) => !sent.has(id));
          await settleTurn(drive, { unsent, ...(settle.opening === undefined ? {} : { host: settle.opening }) });
          state = "idle";
        },
        async turnEnd() {
          if (!running) throw new Error("acp: no turn is in flight");
          return running;
        },
        async interrupt() {
          // The agent is asked to end the turn (session/cancel), and no end is written for it: the turn stays open. If it
          // does not end it within INTERRUPT_MS, the drive is halted, which ends the agent's process.
          interrupted = true;
          const stopped = control ? await control.interrupt(INTERRUPT_MS).catch(() => false) : false;
          if (!stopped) drive.halt?.(new SessionHalt("interrupted"));
          await running?.catch(() => {});
          if (holdsTurn(drive.state())) state = "open_turn";
        },
        async close() {
          if (closed) return;
          closed = true;
          drive.halt?.(new SessionHalt("closed"));
          await running?.catch(() => {});
          await harness.close();
        },
      };
    },
  };
}
