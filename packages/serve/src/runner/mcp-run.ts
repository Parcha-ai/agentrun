// A claimed run's remote MCP servers in the runner's loop (tl-mcp's note, sections 4 to 6). The adapter loop opens this
// once per claim, after its Harness is open and before its session: the claim step (mcp-claim.ts: the pin made or read
// and checked, the pinned servers' credentials opened into this loop's memory), then ONE gateway (mcp-gateway.ts) for
// the loop, never shared with another, reading the step's credentials live. The session reaches it one way per harness:
// - pi (no MCP client of its own): one host tool per pinned tool, under its wire name (`mcp__<server>__<tool>`) with the
//   pinned description and schema, as main's mcpRegistrations named them. Its calls take the loop's path for every host
//   tool: the gate before the intent (allow, ask and park, deny), the flush before the side effect, then the gateway.
// - a harness with its own MCP client (AdapterCapabilities.mcpClient): the session's MCP (`session`), which its adapter
//   mounts once on its model proxy at `/mcp/<server>`. Each call asks the loop's gate first, then runs the same host
//   tool, as the loop wrapped it. Such a harness cannot yet hold a call for a person's answer across a park: an asked
//   call is answered so (cannotWait), nothing sent.
// The gateway itself holds no gate here: the loop's is the run's one gate. It keeps the rest as it is: the pin, the meta
// refusal, the unopened refusal, the URL check per call, prices under the run's cap and the not-metered booking, each
// written on the run's root through the loop's own Harness commit. A priced call goes through the run's priced-step cap
// (RunMcp.cap); one refused for room is answered in the cap's words, unsent, and the run's next model request is refused
// with the same refusal, so the turn ends and the run parks on a raise (main's takePaidRefusal).
import { randomUUID } from "node:crypto";
import type { HostTool, McpCallResult, Refusal, SessionMcp } from "@parcha/agentrun-kernel";
import { type Cap, CapRefused } from "@parcha/agentrun-kernel/kernel/cap";
import { wireName } from "../catalog.js";
import { mcpGateway, type McpPaid, noCallId } from "../mcp-gateway.js";
import { type ApprovalPrice, mcpToolName, type Park } from "../tool-gate.js";
import type { Claim } from "./loop-contract.js";
import { mcpClaim, type McpClaimOptions, type McpClaimStep } from "./mcp-claim.js";

/** A run's remote MCP servers, as its spec names them (AdapterRunSpec.mcp). */
export interface RunMcp {
  /** The run's granted tools, by catalog name (`mcp:<server>/<tool>` among them), as its revision grants them. */
  readonly grants: readonly string[];
  /** Where the claim step reads the registry and writes the run's pin. */
  readonly store: McpClaimOptions["store"];
  /** The runner's seal key (the server's): undefined when it was started without one. */
  readonly sealKey: Buffer | undefined;
  readonly githubApp?: McpClaimOptions["githubApp"];
  readonly network?: McpClaimOptions["network"];
  /** A refresh's bound (mcp-claim.ts). */
  readonly bounds?: McpClaimOptions["bounds"];
  /** The run's priced-step cap (the kernel's createCap, on the same cap figure as the run's model booking, whose rule
   *  reads its spentUsd and heldUsd, as workflow-spec.ts wires its decisions'). A priced call is admitted and settled on
   *  it. Absent on a run with a cap (AdapterRunSpec.cap): a priced call is refused unsent, having nowhere to be held. */
  readonly cap?: Cap;
  /** For tests: the gateway's upstream fetch, and its bounds on one call and a server's first connection. */
  readonly fetch?: typeof fetch;
  readonly callBounds?: { callMs?: number; connectMs?: number };
}

export interface RunMcpOptions {
  readonly claim: Claim;
  /** The claim's signal: the step's credentials are dropped when it aborts. */
  readonly signal: AbortSignal;
  /** The run's work folder, where an answer too long for the model is filed. */
  readonly work: () => string;
  /** The run's commit through its current Harness, once open. */
  readonly commit: () => Park["commit"] | undefined;
  /** The run's barrier (the store's flush): a priced call's hold is durable through it before the call is sent. */
  readonly flush: () => Promise<void>;
  /** Whether the run has a cap (AdapterRunSpec.cap). */
  readonly capped: boolean;
}

/** A call as the loop's gate is asked about it: the tool by its catalog name. */
export type McpGateCall = { readonly callId: string; readonly tool: string; readonly args: Record<string, unknown> };

/** A claim's MCP, open: its step, the tools the session reaches the gateway by, and what the loop asks of it. */
export interface RunMcpOpen {
  readonly step: McpClaimStep;
  /** One host tool per pinned tool, under its wire name. */
  readonly tools: readonly HostTool[];
  /** A pinned tool's catalog name (`mcp:<server>/<tool>`) by its wire name; undefined for any other tool. */
  catalogOf(tool: string): string | undefined;
  /** What an asked call of a pinned tool costs on its card (main's: its price, else "not metered"); undefined for any
   *  other tool. */
  priceOf(name: string): ApprovalPrice | undefined;
  /** The session's MCP for a harness with its own client: each call through `gate` (undefined: let go; a text: refused
   *  in those words, nothing sent), then its host tool from `tools`, as the loop wrapped it. */
  session(tools: ReadonlyMap<string, HostTool>, gate: (call: McpGateCall) => Promise<string | undefined>): SessionMcp;
  /** The refusal for room a priced call met, taken once: the run's next model request is refused with it. */
  takeRefusal(): Refusal | undefined;
  /** Drops every credential held: the loop ended, or the claim is lost. */
  release(): void;
}

const said = (text: string, isError = false): McpCallResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** The run's MCP for one claim: undefined when it grants no MCP tool. Throws McpClaimRefused (the claim refused in words,
 *  nothing sent) or Fenced (the claim lost while a refresh was awaited). */
export async function openRunMcp(spec: RunMcp, options: RunMcpOptions): Promise<RunMcpOpen | undefined> {
  const step = await mcpClaim({
    store: spec.store,
    claim: options.claim,
    grants: spec.grants,
    sealKey: spec.sealKey,
    signal: options.signal,
    ...(spec.bounds ? { bounds: spec.bounds } : {}),
    ...(spec.network ? { network: spec.network } : {}),
    ...(spec.githubApp ? { githubApp: spec.githubApp } : {}),
  });
  const pin = step.pin;
  if (!pin) {
    step.release();
    return undefined;
  }
  let refusal: Refusal | undefined;
  const paid: McpPaid["call"] = async (name, call, charge, hold) => {
    const cap = spec.cap;
    // No cap: the call runs, and books at its price (main's paidCall with no spend). A capped run with no priced-step
    // cap to hold it on: refused unsent, never run past the cap.
    if (!cap) return options.capped ? { refused: `${name} was not sent: this call has no run to book its price under.` } : { result: await call() };
    const id = `mcp:${randomUUID()}`;
    try {
      await cap.admit({ kind: "tool", id, name, holdUsd: hold.usd, basis: hold.basis });
    } catch (error) {
      if (!(error instanceof CapRefused)) throw error;
      // Refused for room: a raise would send it, so the run's next model request is refused with it and the run parks.
      if (!error.forGood && error.figures) refusal = { refuse: error.message, forGood: false, figures: error.figures };
      return { refused: error.message, ...(error.figures ? { leastCapUsd: error.figures.leastCapUsd } : {}) };
    }
    let result: Awaited<ReturnType<typeof call>>;
    try {
      result = await call();
    } catch (error) {
      // It may have charged its hold.
      await cap.settle(id, { end: "charged", usd: null });
      throw error;
    }
    const usd = charge(result);
    await cap.settle(id, { end: "charged", usd: usd === undefined ? 0 : usd });
    return { result };
  };
  const gateway = mcpGateway({
    pin,
    credentials: step.credentials,
    liveCredentials: true,
    work: options.work,
    commit: options.commit,
    paid: { call: paid as McpPaid["call"], sync: options.flush },
    ...(spec.fetch ? { fetch: spec.fetch } : {}),
    ...(spec.callBounds ? { bounds: spec.callBounds } : {}),
  });
  const catalog = new Map<string, string>();
  const tools: HostTool[] = [];
  for (const [server, pinned] of Object.entries(pin)) {
    for (const tool of pinned.tools) {
      const name = mcpToolName(server, tool.name);
      const wire = wireName(name);
      catalog.set(wire, name);
      tools.push({
        name: wire,
        description: tool.description || tool.title || `${tool.name}, a tool of the MCP server ${server}.`,
        inputSchema: tool.inputSchema,
        // Never sent twice: a call a crash cut off is answered interrupted, never run again.
        replay: "never",
        call: async (args, context) => {
          const result = await gateway.call(server, tool.name, (args ?? {}) as Record<string, unknown>, { signal: context.signal, callId: context.callId });
          return { text: result.content.map((block) => block.text).join("\n\n"), ...(result.isError ? { isError: true } : {}) };
        },
      });
    }
  }
  return {
    step,
    tools,
    catalogOf: (tool) => catalog.get(tool),
    priceOf(name) {
      const parsed = /^mcp:([^/]+)\/(.+)$/.exec(name);
      const pinned = parsed && Object.hasOwn(pin, parsed[1]!) ? pin[parsed[1]!] : undefined;
      if (!pinned?.tools.some((tool) => tool.name === parsed![2])) return undefined;
      return pinned.prices && Object.hasOwn(pinned.prices, parsed![2]!) ? pinned.prices[parsed![2]!]! : "not metered";
    },
    session: (wrapped, gate) => ({
      servers: gateway.servers,
      async call(server, tool, args, { signal, callId }) {
        const name = mcpToolName(server, tool);
        const host = wrapped.get(wireName(name));
        if (!host) return said(`${tool} is not a tool of the MCP server ${server} in this run.`, true);
        // The gate and the run's record know a call by its id: one without is never sent.
        if (!callId) return said(noCallId(name), true);
        const refused = await gate({ callId, tool: name, args });
        if (refused !== undefined) return said(refused, true);
        const answer = await host.call(args, { callId, signal });
        return said(answer.text, answer.isError === true);
      },
    }),
    takeRefusal() {
      const taken = refusal;
      refusal = undefined;
      return taken;
    },
    release: () => step.release(),
  };
}
