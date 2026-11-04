// The tool gate: one gate every tool call passes, on every harness (plan item 4, "approvals that pause and resume").
// Each tool has a permission: allow (it runs), deny (it is refused, and the model reads why), or ask (a person approves
// or denies it first). The run's tool paths call it: pi's tools, wrapped where the run's registry composes its agents'
// tools (app.ts), the kernel's host tools on claude-agent and codex (host-tools.ts), and, with hold mode, the MCP
// gateway. Park mode is built (RunGate); hold mode and the executors of tool families the gate does not own come next.
//
// Two ways an ask waits, chosen by the caller:
// - PARK (the default; pi's tools and the kernel's host tools). The gated call answers at once with WAITING_TEXT and
//   the turn ends, as ask_person's does; the run goes needs_input with the pending approval. On an answer the gate runs
//   the approved call itself (its tool family's executor, exactly once, through the journaled path) and resumes the
//   session with a message naming the call. No CLI waits inside a tool call, so no CLI tool timeout applies.
// - HOLD (`{ hold: true }`; the MCP gateway, per the owner's ruling of 11-04). The gate raises the SAME pending approval
//   (needs_input, pending.kind "approval", the Timeline row, the same answer route) and returns a promise the caller
//   awaits while it holds the CLI's MCP call open: undefined on allow (the caller then calls upstream and passes the
//   result through spill), the refusal on deny. The turn does not end; the run reads needs_input while the call is
//   held and working once it is answered. An abort (`signal`: a cancel, or the client went away) rejects the promise
//   with GateAborted. If the run's process dies while a call is held, the call is answered interrupted when the run
//   resumes, the approval stays pending, and an approval given later runs it through the executor once and resumes
//   the session with a message naming the call: park's semantics are the fallback. In hold mode a second ask QUEUES
//   behind the first and raises its approval when the first is answered (CLIs make parallel MCP calls); in park mode
//   a second ask is refused while one waits.
//
// The answer: POST /v2/runs/{id}/approvals/{approval_id} { decision: "allow" | "deny", note? } -> 204. The first answer
// wins; the same answer again is 204, a conflicting one 409. Only the owner's password session answers (server.ts), never
// a token. A cancel marks pending approvals canceled. There is no ask
// timeout. A run nobody attends (a trigger's, later) denies what is set to ask.
//
// Park mode, in the run's process: the asked call's request is kept in the run's own store (an `agentrun.tool_approval`
// entry on its root conversation), so a restart keeps it. The server keeps a person's answer in the run's serve.json
// (runs.ts); the gate reads it there, runs an allowed call once through the kernel's journal (the intent-then-outcome
// effect any host tool's call is, on a session key of its own: a call a crash cut off runs again only where it is
// replay-safe, and is answered interrupted otherwise) on the run's own coding source, and resumes the session with one
// message that names the call and carries its result, or the refusal. A result is cut as every host tool's is
// (HOST_RESULT_MAX_CHARS); the gate spills nothing.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type Cursor, defineExtension, type Extension, ROOT_CONVERSATION_ID, type ToolRegistration, type Tx, wrapTool } from "@earendil-works/pi-durable";
import { type Drive, EffectFailure, openDrive } from "@parcha/agentrun-kernel/kernel";
import type { DurableRun } from "@parcha/pi-durable-disk";
import { readJson, RUN_META } from "./files.js";
import { hostTools } from "./host-tools.js";
import { LEARNED_DIR } from "./learning.js";
import type { TurnOrigin } from "./learning-run.js";
import { forModel } from "./result.js";
import { durableSessions } from "./sessions.js";
import { ToolSettings } from "./tool-plane.js";

/** What the gate does with a tool's calls. */
export const PERMISSIONS = ["allow", "ask", "deny"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** An MCP tool's gate name: `mcp:<server>/<tool>`. */
export const mcpToolName = (server: string, tool: string): string => `mcp:${server}/${tool}`;
/** Whether `name` is an MCP tool's gate name. */
export const isMcpTool = (name: string): boolean => /^mcp:[^/]+\/.+$/.test(name);
/** A third-party catalog tool, by its name: monid's (`monid.<tool>`) or an MCP server's (`mcp:<server>/<tool>`). */
export const isCatalogTool = (name: string): boolean => name.startsWith("monid.") || isMcpTool(name);
/** The owner's defaults (11-01): a built-in kernel tool allow; a third-party catalog tool ask. */
export const defaultPermission = (name: string): Permission => (isCatalogTool(name) ? "ask" : "allow");

/** The settings keys that may set `name`'s permission, most specific first: the tool's own name, then, for an MCP
 *  tool, its server's wildcard `mcp:<server>/*`. */
export function permissionKeys(name: string): string[] {
  if (!isMcpTool(name)) return [name];
  return [name, `${name.slice(0, name.indexOf("/"))}/*`];
}

/** A layer of tool settings (the server's, PUT /v2/settings/tools, or an agent's own, definition.tool_settings) as the
 *  gate reads it: a permission by settings key. */
export type PermissionSettings = Readonly<Record<string, { permission?: Permission } | undefined>>;

/** `name`'s permission in force and the layer it came from, most specific first: the agent's exact key, the agent's
 *  server wildcard, the server's exact key, the server's server wildcard, then the default. Rules over a call's
 *  arguments are not in V1. */
export function permissionFrom(name: string, server: PermissionSettings, agent: PermissionSettings = {}): { permission: Permission; from: "agent" | "server" | "default" } {
  for (const [from, layer] of [["agent", agent], ["server", server]] as const) {
    for (const key of permissionKeys(name)) {
      const set = layer[key]?.permission;
      if (set) return { permission: set, from };
    }
  }
  return { permission: defaultPermission(name), from: "default" };
}

/** `name`'s permission in force (permissionFrom): the one rule every path reads, the gate's, the tool plane's and a
 *  workflow's call nodes'. */
export const permissionOf = (name: string, server: PermissionSettings, agent: PermissionSettings = {}): Permission => permissionFrom(name, server, agent).permission;

/** A call's answer as the model reads it: its text, and whether it failed. */
export type ToolAnswer = { text: string; isError: boolean };

/** A held approval's price for the person who answers it: USD where the tool declares one (held and booked through the
 *  spend cap's paidCall), else "not metered" (an unpriced MCP call, the owner's ruling of 11-04). */
export type ApprovalPrice = number | "not metered";

/** One pending approval, as the run's view shows it (`pending`) and the console's approval card reads it. */
export type PendingApproval = {
  kind: "approval";
  /** The approval's id, the answer route's `{approval_id}`; the same for the same call after a crash. */
  id: string;
  tool: string;
  call_id: string;
  /** The call's arguments as text, at most ARGS_PREVIEW_BYTES. */
  args_preview: string;
  requested_at: string;
  /** Whether the call is held open (hold mode) rather than parked. */
  held: boolean;
  price?: ApprovalPrice;
};

/** The run's journal commit for the call, which makes the request durable before the gate answers. */
export type Park = { commit<T>(change: (tx: unknown) => Promise<T>): Promise<T>; parked?(callId: string): void };

/** How a call waits when its tool is set to ask; see the header. */
export type EnterOptions = {
  /** Hold the call open until it is answered (the MCP gateway); default false: park and end the turn. */
  hold?: boolean;
  /** Aborts a held wait: a cancel, or the client went away. */
  signal?: AbortSignal;
  /** What the approval card shows the call costs. */
  price?: ApprovalPrice;
};

/** enter's answer. `undefined`: run the call (and pass its result through spill). Otherwise the answer the model reads
 *  instead: a refusal (`isError: true`), or, in park mode, the waiting text with `parked: true`, after which the caller
 *  ends the turn. */
export type Entered = undefined | (ToolAnswer & { parked?: true });

/** Runs an APPROVED parked call of a tool family the gate does not own (the MCP gateway's), exactly once. */
export type Executor = (tool: string, args: unknown, callId: string, signal: AbortSignal) => Promise<ToolAnswer>;

/** A held wait ended by its signal, before an answer. */
export class GateAborted extends Error {
  constructor(readonly tool: string, readonly callId: string) {
    super(`The ${tool} call ${callId} stopped waiting for its approval.`);
    this.name = "GateAborted";
  }
}

/** The gate of one run, in the run's process. */
export interface Gate {
  /** One model-initiated call at the gate: allow, deny, or ask (park or hold; see the header). */
  enter(tool: string, args: unknown, callId: string, park: Park, options?: EnterOptions): Promise<Entered>;
  /** Registers how an approved parked call of tools named `prefix…` (e.g. "mcp:") runs; one per prefix and run. */
  executor(prefix: string, run: Executor): void;
  /** A call's result text as the model gets it: one over SPILL_BYTES is saved under the run's work/ and replaced by
   *  its path and a preview. */
  spill(callId: string, text: string): string;
}

/** The refusal of a call whose tool is set to deny. */
export const deniedText = (tool: string): string => `Permission denied: ${tool} is set to deny on this server. Don't retry it.`;
/** A parked call's answer: the run pauses here. */
export const waitingText = (tool: string): string => `This ${tool} call waits for a person's approval; the run pauses here and continues with the result when they answer.`;
/** A call a person denied, with their reason when they gave one. */
export const refusedText = (tool: string, note?: string): string => `The user denied this ${tool} call.${note ? ` Reason: ${note}` : ""}`;
/** A held call the run's process died during: it was not run, and its approval stays pending. */
export const interruptedText = (tool: string): string => `This ${tool} call was interrupted while it waited for a person's approval; it was not run. If they approve it, it runs then and the run continues with its result.`;

/** The Timeline row of a call that waits for an approval. */
export const APPROVAL_ROW = "tool_approval_requested";
/** A call's arguments shown on its approval, at most this many bytes. */
export const ARGS_PREVIEW_BYTES = 2048;
/** A result over this many bytes is spilled to work/ (see spill). */
export const SPILL_BYTES = 48 * 1024;
/** The preview a spilled result keeps. */
export const PREVIEW_BYTES = 8 * 1024;

/** A gate of `policy` (the run's permission of a tool now) with no run behind it: allow and deny are enforced and
 *  executors are kept; an ask throws, since nothing here can park or hold a call (a run's is RunGate), and spill returns
 *  the text as it is. */
export function gateOf(policy: (tool: string) => Permission): Gate {
  const executors = new Map<string, Executor>();
  return {
    async enter(tool) {
      const permission = policy(tool);
      if (permission === "allow") return undefined;
      if (permission === "deny") return { text: deniedText(tool), isError: true };
      throw new Error(`A gate with no run cannot ask a person about ${tool}.`);
    },
    executor(prefix, run) {
      executors.set(prefix, run);
    },
    spill(_callId, text) {
      return text;
    },
  };
}


/** The file in a run's directory that names the origin of the turn it runs now: written by the server alone, as it sends
 *  the learning lane's reflect turn (runs.ts's toLiveDoor), and gone once a person's message comes. */
export const TURN_ORIGIN_FILE = "turn-origin.json";
/** The run's store's record of a call that waits for approval (`phase: "requested"`), and of its answer acted on
 *  (`phase: "resolved"`), on its root conversation. */
export const APPROVAL_ENTRY = "agentrun.tool_approval";

/** What the gate does with one call: `policy` gives the run's permission of a tool, `turnOrigin` the turn's (from the
 *  server's internal path only), `work` the run's work/. Under ask, a write or an edit of a reflect turn whose path lies
 *  inside work/.learning/ runs without asking; under deny nothing runs. */
export function gateToolCall(call: { tool: string; args: unknown }, { turnOrigin, work, policy }: { turnOrigin?: TurnOrigin; work: string; policy: (tool: string) => Permission }): Permission {
  const permission = policy(call.tool);
  if (permission !== "ask") return permission;
  const path = (call.args as { path?: unknown } | null | undefined)?.path;
  return turnOrigin === "reflect" && (call.tool === "write" || call.tool === "edit") && inLearning(work, path) ? "allow" : "ask";
}

/** Whether `path`, resolved against `work` as pi's file tools resolve it (a leading `@` dropped, Unicode spaces made
 *  plain, then lexically), names a file inside work/.learning/ with no link on the way: no component from work/ down
 *  that exists is a link, so nothing a link points at counts as inside. */
export function inLearning(work: string, path: unknown): boolean {
  if (typeof path !== "string" || path.includes("\0")) return false;
  const plain = path.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
  const root = resolve(work);
  const target = resolve(root, plain.startsWith("@") ? plain.slice(1) : plain);
  const below = relative(join(root, LEARNED_DIR), target);
  if (!below || below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) return false;
  let at = root;
  for (const part of relative(root, target).split(sep)) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return false;
    } catch (error) {
      // Missing: nothing below it exists either. Anything else is not known to be inside.
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return true;
}

/** One call that waits for approval, as the run's store keeps it. */
export type ApprovalRequest = { id: string; tool: string; call_id: string; args: unknown; args_preview: string; requested_at: string };
/** Resumes the session with `content` as one message of its own (`approval-<id>`), writing `mark` with it or after it. */
export type Resume = (id: string, content: string, mark: (tx: Tx) => Promise<unknown>) => Promise<void>;

/** `args` as JSON, at most ARGS_PREVIEW_BYTES. */
export function argsPreview(args: unknown): string {
  const bytes = Buffer.from(JSON.stringify(args ?? {}) ?? "", "utf8");
  return bytes.length <= ARGS_PREVIEW_BYTES ? bytes.toString("utf8") : `${bytes.subarray(0, ARGS_PREVIEW_BYTES - 3).toString("utf8").replace(/\uFFFD+$/, "")}…`;
}

/** The one message that resumes a session once a person answered: it names the call it answers (its tool, call id and
 *  arguments), so the model tells it from a person's new input, and carries the call's result, or the refusal. */
export function resumeText(request: Pick<ApprovalRequest, "tool" | "call_id" | "args_preview">, decision: "allow" | "deny", result: ToolAnswer): string {
  const args = request.args_preview.length > 300 ? `${request.args_preview.slice(0, 299)}…` : request.args_preview;
  const head = `[tool approval] This answers your ${request.tool} call ${request.call_id} (arguments ${args}), which waited for a person's approval; it is not a new message from them.`;
  return decision === "allow" ? `${head} They allowed it, and it ran${result.isError ? " and failed" : ""}. Its result:\n${result.text}` : `${head}\n${result.text}`;
}

/** The gate of the run `runId` at `where` (its directory, under the data directory's runs/), on its pinned revision:
 *  an agentic run's parks an asked call; a workflow's model node cannot. */
export function runGate(where: { root: string; work: string }, runId: string, revision: { kind: string; body: { toolSettings?: unknown } }): RunGate {
  return new RunGate({ root: where.root, work: where.work, data: resolve(where.root, "..", ".."), runId }, (revision.body.toolSettings ?? {}) as PermissionSettings, revision.kind === "agentic");
}

/** The gate in a run's process, park mode: its policy, the turn's origin, the calls that wait, and the answers acted on. */
export class RunGate {
  private readonly requests = new Map<string, ApprovalRequest & { resolved?: true }>();
  private durable?: DurableRun;
  private context?: Context;
  private coding?: readonly ToolRegistration[];
  private resume?: Resume;
  private drive?: Promise<Drive>;
  private timer?: NodeJS.Timeout;
  private settling = false;
  private readonly stop = new AbortController();

  /** `where.data`: the server's data directory, its tool settings beside the store; `overrides`: the pinned revision's
   *  own; `parks`: whether an asked call parks the run (an agentic run's), which a workflow's model node cannot. */
  constructor(private readonly where: { root: string; work: string; data: string; runId: string }, private readonly overrides: PermissionSettings = {}, private readonly parks = true) {}

  /** A tool's permission now (permissionOf): the revision's own over the server's setting, read at each call, so a change
   *  reaches a live run at its next call. */
  readonly policy = (tool: string): Permission => permissionOf(tool, new ToolSettings(this.where.data, () => undefined).get() as PermissionSettings, this.overrides);

  /** The origin of the turn running now: what the server's internal path wrote for it; none for a person's turn. */
  turnOrigin(): TurnOrigin | undefined {
    try {
      return (JSON.parse(readFileSync(join(this.where.root, TURN_ORIGIN_FILE), "utf8")) as { origin?: unknown })?.origin === "reflect" ? "reflect" : undefined;
    } catch {
      return undefined;
    }
  }

  /** One model-initiated call at the gate: undefined when it may run; else its answer, refused at once (deny) or parked
   *  (ask). One call waits at a time: another asked meanwhile is answered so, not run. */
  async enter(tool: string, args: unknown, callId: string, park: Park, options: EnterOptions = {}): Promise<Entered> {
    const permission = this.policy(tool);
    const turnOrigin = permission === "ask" ? this.turnOrigin() : undefined;
    const verdict = gateToolCall({ tool, args }, { ...(turnOrigin ? { turnOrigin } : {}), work: this.where.work, policy: () => permission });
    if (verdict === "allow") return undefined;
    if (verdict === "deny") return { text: deniedText(tool), isError: true };
    if (options.hold) throw new Error(`Holding a call open for its approval comes with the MCP gateway's approvals (${tool}).`);
    if (!this.parks) return { text: `This ${tool} call needs a person's approval, which a workflow's model node cannot wait for; it was not run.`, isError: true };
    // Named by the call, so a call run again after a crash parks as the same request.
    const id = `ap_${createHash("sha256").update(JSON.stringify([callId, tool, args ?? null])).digest("hex").slice(0, 16)}`;
    const other = [...this.requests.values()].find((held) => !held.resolved && held.id !== id);
    if (other) return { text: `This ${tool} call was not run: the ${other.tool} call ${other.call_id} already waits for a person's approval. Call it again once that one is answered.`, isError: true };
    if (!this.requests.has(id)) {
      const request: ApprovalRequest = { id, tool, call_id: callId, args: args ?? null, args_preview: argsPreview(args), requested_at: new Date().toISOString() };
      await park.commit((tx) => (tx as Tx).appendEntry(ROOT_CONVERSATION_ID, { kind: APPROVAL_ENTRY, data: { phase: "requested", ...request } as never }));
      this.requests.set(id, request);
    }
    park.parked?.(callId);
    this.watch();
    return { text: waitingText(tool), isError: false, parked: true };
  }

  /** pi's `tools` behind the gate: wraps, by name, for the run's registry, which apply wherever it is selected (every
   *  agent selects it: the root by default, a workflow's model node by name, app.ts). */
  extension(tools: readonly ToolRegistration[]): Extension {
    const named = [...new Map(tools.map((tool) => [tool.name, tool])).values()];
    return defineExtension({ name: "tool-gate", wraps: named.map((tool) => wrapTool(tool, (inner) => this.wrap(inner))) });
  }

  private wrap(tool: ToolRegistration): ToolRegistration {
    const gate = this;
    return {
      ...tool,
      async execute(args, api, context) {
        const answer = await gate.enter(tool.name, args, api.callId, { commit: (change) => api.commit(change as never, context) as never });
        // A parked call ends the turn, as ask_person's does.
        if (answer) return forModel(answer.text, answer.parked ? { control: { terminate: true } } : { isError: true });
        return tool.execute(args, api, context);
      },
    } as ToolRegistration;
  }

  /** Reads the requests the run's store holds, as the run's process opens, before its turns go on. `coding`: the run's
   *  coding source (coding-tools.ts), on which an approved coding call runs, as the run's own would. */
  async load(durable: DurableRun, context: Context, coding?: readonly ToolRegistration[]): Promise<void> {
    this.durable = durable;
    this.context = context;
    this.coding = coding;
    const root = await durable.harness.conversation(ROOT_CONVERSATION_ID, context);
    for (let cursor: Cursor | undefined; root; ) {
      const page = await root.entries({ order: "ascending" }, 500, cursor, context);
      for (const entry of page.items) this.note(entry as { kind: string; data?: unknown });
      if (page.next === undefined) break;
      cursor = page.next;
    }
  }

  /** Whether a call waits for its answer, or for its answer to be acted on: a harness keeps the turn it ended closed. */
  waiting(): boolean {
    return [...this.requests.values()].some((held) => !held.resolved);
  }

  /** Acts on the answers from now on, resuming the session through `resume`; by default pi's root conversation. */
  start(resume?: Resume): void {
    this.resume = resume ?? this.submit;
    this.watch();
  }

  private note(entry: { kind: string; data?: unknown }): void {
    const data = entry.data as (ApprovalRequest & { phase?: string }) | undefined;
    if (entry.kind !== APPROVAL_ENTRY || typeof data?.id !== "string") return;
    const held = this.requests.get(data.id);
    if (data.phase === "requested" && !held) this.requests.set(data.id, data);
    else if (data.phase === "resolved" && held) held.resolved = true;
  }

  /** Reads the run's serve.json for answers while a call waits. */
  private watch(): void {
    if (this.timer || !this.resume || !this.waiting()) return;
    this.timer = setInterval(() => void this.settle(), 250);
    this.timer.unref();
    void this.settle();
  }

  /** pi's resume: an input to the root conversation under the request's own id, which pi takes once however often it
   *  is sent, then the mark. */
  private readonly submit: Resume = async (id, content, mark) => {
    const root = await this.durable!.harness.root(this.context!);
    await root.submit({ type: "input", requestId: `approval-${id}`, content, whenBusy: "followUp" }, this.context!);
    await this.durable!.harness.commit(mark, this.context!);
  };

  private async settle(): Promise<void> {
    if (this.settling) return;
    const open = [...this.requests.values()].filter((held) => !held.resolved);
    if (!open.length) {
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    this.settling = true;
    try {
      const answers = (await readJson(join(this.where.root, RUN_META)))?.approvals as Record<string, { decision?: string; note?: string }> | undefined;
      for (const held of open) {
        const answer = answers?.[held.id];
        if (answer?.decision !== "allow" && answer?.decision !== "deny") continue;
        const decision = answer.decision;
        // An allow runs the call, unless its tool was set to deny since it asked.
        const result = decision === "deny" ? { text: refusedText(held.tool, answer.note), isError: true } : this.policy(held.tool) === "deny" ? { text: deniedText(held.tool), isError: true } : await this.run(held);
        await this.resume!(held.id, resumeText(held, decision, result), (tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: APPROVAL_ENTRY, data: { phase: "resolved", id: held.id, decision } }));
        held.resolved = true;
      }
    } catch (error) {
      // Tried again at the next tick: the call's effect answers from its journal, and the resume is taken once.
      process.stderr.write(`agentrun-serve: an answered approval is not acted on yet: ${(error as Error)?.message ?? error}\n`);
    } finally {
      this.settling = false;
    }
  }

  /** The approved call, run once by the kernel through the journal any host tool's call goes through, as an effect of
   *  the run's own `approvals:` session, on the run's coding source: its intent is durable before it runs, its outcome
   *  after; a replay-safe call a crash cut off runs again, any other is answered interrupted and never runs again. */
  private async run(held: ApprovalRequest): Promise<ToolAnswer> {
    const [tool] = hostTools(this.durable!, [held.tool], this.context!, new Map(), this.coding);
    if (!tool) return { text: `The approved ${held.tool} call is not one the kernel runs outside the model's turn.`, isError: true };
    this.drive ??= durableSessions(this.durable!.harness, this.context!)
      .open(`approvals:${this.where.runId}`)
      .then((writer) => openDrive({ writer, signal: this.stop.signal }))
      .catch((error: unknown) => {
        this.drive = undefined;
        throw error;
      });
    try {
      return await (await this.drive).effect(`approval:${held.id}`, { name: held.tool, replay: tool.replay, input: held.args }, async ({ signal }) => {
        const answer = await tool.call(held.args, { callId: held.call_id, signal });
        return { text: answer.text, isError: answer.isError === true };
      });
    } catch (error) {
      // Its outcome (interrupted, or a throw), journaled; anything else (the drive fenced) is tried again.
      if (error instanceof EffectFailure) return { text: error.message, isError: true };
      throw error;
    }
  }
}
