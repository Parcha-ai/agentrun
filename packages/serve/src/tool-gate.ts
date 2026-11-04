// The tool gate: one gate every tool call passes, on every harness (plan item 4, "approvals that pause and resume").
// Each tool has a permission: allow (it runs), deny (it is refused, and the model reads why), or ask (a person approves
// or denies it first). This file is the INTERFACE the run's tool paths call, the kernel's host tools and the MCP gateway
// alike; the approvals PR fills in the bodies marked below.
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
// wins; the same answer again is 200, a conflicting one 409. A cancel marks pending approvals canceled. There is no ask
// timeout. A run nobody attends (a trigger's, later) denies what is set to ask.

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

/** `name`'s permission in force, most specific first: the agent's exact key, the agent's server wildcard, the server's
 *  exact key, the server's server wildcard, then the default. Rules over a call's arguments are not in V1. */
export function permissionOf(name: string, server: PermissionSettings, agent: PermissionSettings = {}): Permission {
  for (const layer of [agent, server]) {
    for (const key of permissionKeys(name)) {
      const set = layer[key]?.permission;
      if (set) return set;
    }
  }
  return defaultPermission(name);
}

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

/** A gate of `policy` (the run's permission of a tool now). INTERFACE COMMIT: allow and deny are enforced and executors
 *  are kept; an ask throws until the approvals PR fills in parking, holding and answering, and spill returns the text
 *  as it is. */
export function gateOf(policy: (tool: string) => Permission): Gate {
  const executors = new Map<string, Executor>();
  return {
    async enter(tool) {
      const permission = policy(tool);
      if (permission === "allow") return undefined;
      if (permission === "deny") return { text: deniedText(tool), isError: true };
      throw new Error(`The approvals gate's ask is not built yet (${tool}).`);
    },
    executor(prefix, run) {
      executors.set(prefix, run);
    },
    spill(_callId, text) {
      return text;
    },
  };
}

// Stubs so the gate's tests load and each case fails on its own assertion; the next commit builds them.
/** Where a run's root records the current turn's origin, which the reflect carve-out reads. */
export const TURN_ORIGIN_FILE = "turn-origin.json";

/** One call's verdict before the run's gate acts on it. Today: everything is allowed. */
export const gateToolCall = (_call: { tool: string; args: unknown }, _at: { turnOrigin?: string; work: string; policy: (tool: string) => Permission }): Permission => "allow";

/** A run's gate. Today: every tool is allowed and enter runs every call. */
export class RunGate {
  constructor(
    readonly where: { root: string; work: string; data: string; runId: string },
    readonly overrides: PermissionSettings = {},
    readonly parks = true,
  ) {}
  policy(_tool: string): Permission {
    return "allow";
  }
  async enter(_tool: string, _args: unknown, _callId: string, _park: Park, _options: EnterOptions = {}): Promise<Entered> {
    return undefined;
  }
}
