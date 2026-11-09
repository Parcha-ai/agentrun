// A claimed run's remote MCP servers on the runner (tl-mcp's note, sections 4 to 6). A spec builder calls mcpForClaim once
// per claim, inside the adapter loop's spec step: after the loop's Gate and Harness are open, before its session. It runs
// the claim step (mcp-claim.ts: the pin made at the first claim or read as written, checked against the meta tools known
// now, the pinned servers' credentials opened into this claim's memory) and builds ONE gateway (mcp-gateway.ts) for the
// claim, never shared with another, reading those credentials live. The builder puts what it returns in its spec
// (AdapterRunSpec.mcp); the loop does the rest:
// - pi (no MCP client of its own) gets one host tool per pinned tool (`tools`), under its wire name with the pinned
//   description and schema, as main's mcpRegistrations named them, on the loop's path for every host tool: the gate
//   before the intent (allow, ask and park, deny), the flush, the record, the run's one ledger for a priced call.
// - a harness with its own MCP client gets the session's MCP (`session`), which its adapter mounts once on its model
//   proxy at `/mcp/<server>`: each call asks the loop's gate first, then runs the same host tool as the loop wrapped it.
//   An asked call parks the run as main's gate did through the door: the CLI is answered the waiting words, marked parked,
//   and nothing is sent. The claim that resumes it answers it (parkedFollowUp): an allow runs the call once, a deny is
//   told in words, and the session goes on with main's resume message for it.
// - a command row handed to the running loop makes the credentials fresh again (`fresh`, on the same pin) before its
//   next model request; the loop calls `release` when its pass ends, the claim is lost or its signal aborts.
// The gateway holds no gate here (the loop's is the run's one gate) and keeps the rest as it is: the meta refusal, the
// unopened refusal, the URL check per call, the scrub of each call's credentials held only while that call is out, prices
// on the run's one ledger and the not-metered booking on the run's root.
import type { HostTool, McpCallResult, SessionMcp } from "@parcha/agentrun-kernel";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { wireName } from "../catalog.js";
import { mcpGateway, type McpGatewayOptions, noCallId } from "../mcp-gateway.js";
import type { OAuthNetwork } from "../mcp-oauth.js";
import type { Store, TriggerSettings } from "../store/index.js";
import { type ApprovalPrice, argsPreview, mcpToolName, resumeText, RESUME_PREFIX, waitingText } from "../tool-gate.js";
import { deniedText } from "./loop-contract.js";
import { type AnswerData, type AskData, type CallEndData, KINDS } from "./journal-kinds.js";
import type { Claim } from "./loop-contract.js";
import { mcpClaim, type McpClaimStep } from "./mcp-claim.js";
import type { GithubAppAccess, GithubTimer } from "./mcp-github.js";

/** The GitHub App access for a claim (runner/github-app.ts githubAppAccess, tl-triggers'): the server's App, read from
 *  the store with the runner's seal key, bound to the repository the run's launch input names. */
export type GithubAppAccessOf = (store: { readonly triggerSettings: Pick<TriggerSettings, "get"> }, sealKey: Buffer | undefined, launchInput: unknown) => Promise<GithubAppAccess | undefined>;

export interface McpForClaimOptions {
  /** The claim this pass holds: the pin is written under its fence, and a refresh is confirmed against its epoch. */
  readonly claim: Claim;
  /** The one store: the registry's rows, the run's pin row and its run row (the epoch), the GitHub App's settings, and
   *  where it is (Store.where: the claims waiting on a server's refresh lease meet by it). */
  readonly store: Pick<Store, "mcp" | "runs" | "settings" | "triggerSettings" | "where">;
  /** The runner's seal key (the server's): always present (seal-key.ts boots one before any claim), so the claim's sealed
   *  credentials always open; there is no no-seal-key path here (E6). */
  readonly sealKey: Buffer;
  /** The run's granted tools, by catalog name (`mcp:<server>/<tool>` among them), as its revision grants them. */
  readonly grants: readonly string[];
  /** The loop's Harness for this pass (AdapterRun.harness): a call's records (not metered) go on the run's root through it. */
  readonly harness: Pick<Harness, "commit">;
  /** The run's work folder, where an answer too long for the model is filed. */
  readonly work: McpGatewayOptions["work"];
  /** What the run was started with (its launch body's input): the repository a github_app server's token is made for. */
  readonly launchInput?: unknown;
  /** The GitHub App access for a github_app server (githubAppAccess). None: such a server's calls are refused in words
   *  (GITHUB_UNUSABLE.noAccess). */
  readonly githubAppAccess?: GithubAppAccessOf;
  /** For tests: the authorization servers' network, a refresh's bound, the gateway's upstream fetch and bounds, and the
   *  timer a github_app token's refresh is armed on. */
  readonly network?: OAuthNetwork;
  readonly bounds?: { requestMs?: number; tries?: number };
  readonly fetch?: typeof fetch;
  readonly callBounds?: { callMs?: number; connectMs?: number };
  readonly githubTimer?: GithubTimer;
}

/** A call as the loop's gate is asked about it: the tool by its catalog name. */
export type McpGateCall = { readonly callId: string; readonly tool: string; readonly args: Record<string, unknown> };
/** The loop's gate's answer to a call through the door: let go (undefined), refused in words, or parked (the run parks on
 *  its ask, nothing sent). */
export type McpGateAnswer = undefined | { readonly refused: string } | { readonly parked: true };

/** A claim's MCP (AdapterRunSpec.mcp): what the loop reaches the gateway by, and the claim step's own hooks. */
export interface ClaimMcp {
  /** One host tool per pinned tool, under its wire name: pi's tools, and what `session`'s calls run. Each reaches the
   *  gateway only as the loop wraps it, behind the run's one gate (the gate before the intent); nothing else does. */
  readonly tools: readonly HostTool[];
  /** A pinned tool's catalog name (`mcp:<server>/<tool>`) by its wire name; undefined for any other tool. */
  catalogOf(tool: string): string | undefined;
  /** What an asked call of a pinned tool costs on its card (main's: its price, else "not metered"); undefined otherwise. */
  priceOf(name: string): ApprovalPrice | undefined;
  /** The session's MCP for a harness with its own client: each call through `gate` (let go; refused in words, nothing
   *  sent; or parked, answered the gate's waiting words marked parked, nothing sent), then its host tool from `wrapped`,
   *  as the loop wrapped it. */
  session(wrapped: ReadonlyMap<string, HostTool>, gate: (call: McpGateCall) => Promise<McpGateAnswer>): SessionMcp;
  /** The credential values the gateway's calls in flight hold, for a redaction: each call's for as long as it is out,
   *  with any token refreshed while it was; none when idle. */
  redactions(): string[];
  /** The claim step's credentials opened again on the same pin (an expired OAuth token refreshed), then the claim
   *  confirmed: before a resumed loop's next model request. */
  fresh(): Promise<void>;
  /** Drops every credential held: the pass ended, the claim is lost, or its signal aborted. */
  release(): void;
}

const said = (text: string, isError = false): McpCallResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** The run's MCP for one claim: undefined when it grants no MCP tool. Throws McpClaimRefused (a pin that cannot be made,
 *  a pinned tool that is a meta tool now: the loop ends the run in those words, before its session opens) or Fenced (the
 *  claim lost while a refresh was awaited: the loop ends interrupted). A builder calls it before it takes anything it
 *  would have to let go, since a throw here leaves its spec unbuilt and its release uncalled. */
export async function mcpForClaim(options: McpForClaimOptions): Promise<ClaimMcp | undefined> {
  // The step's own signal: aborted by release(), which the loop calls when its pass ends, the claim is lost or its
  // signal aborts.
  const held = new AbortController();
  const githubApp = options.githubAppAccess ? await options.githubAppAccess(options.store, options.sealKey, options.launchInput) : undefined;
  let step: McpClaimStep;
  try {
    step = await mcpClaim({
      store: options.store,
      claim: options.claim,
      grants: options.grants,
      sealKey: options.sealKey,
      signal: held.signal,
      ...(options.bounds ? { bounds: options.bounds } : {}),
      ...(options.network ? { network: options.network } : {}),
      ...(githubApp ? { githubApp } : {}),
      ...(options.githubTimer ? { githubTimer: options.githubTimer } : {}),
    });
  } catch (error) {
    held.abort();
    throw error;
  }
  const pin = step.pin;
  if (!pin) {
    held.abort();
    return undefined;
  }
  const gateway = mcpGateway({
    pin,
    credentials: step.credentials,
    liveCredentials: true,
    work: options.work,
    commit: () => <T>(change: (tx: unknown) => Promise<T>) => options.harness.commit(change as never, BACKGROUND_CONTEXT) as Promise<T>,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.callBounds ? { bounds: options.callBounds } : {}),
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
        const answer = await gate({ callId, tool: name, args });
        if (answer && "refused" in answer) return said(answer.refused, true);
        // The run parks on its ask: the CLI reads main's waiting words, and its adapter records the call as one that did not
        // run (McpCallResult.parked); the claim that resumes the run answers it (parkedFollowUp).
        if (answer) return { ...said(waitingText(name)), parked: true };
        const result = await host.call(args, { callId, signal });
        return said(result.text, result.isError === true);
      },
    }),
    redactions: () => gateway.heldValues(),
    fresh: () => step.fresh(),
    release: () => held.abort(),
  };
}

/** What the loop lends parkedFollowUp: the journal's root entries, its answer for an asked call (an answer entry, the
 *  approve or deny row the claim was handed, or a park when none came: AdapterLoop answerOf), its gate's word on a call
 *  now (a deny set since it asked refuses it), and the call itself through the loop's host-tool path. */
export interface ParkedFollowUpOptions {
  readonly entries: readonly { readonly kind: string; readonly data?: unknown }[];
  answer(call: McpGateCall, price: ApprovalPrice | null): Promise<AnswerData | "park">;
  deniedNow(call: McpGateCall): Promise<string | undefined>;
  run(call: McpGateCall): Promise<{ text: string; isError?: boolean }>;
}

/** For a harness with its own MCP client, on a claim that finds its MCP calls parked through the door: each asked call's
 *  answer acted on once, as main's gate did after a person answered (tool-gate.ts): an allow runs the call through the
 *  loop's path (its start and end on the run's record, never sent twice: a call with an end is answered from it), a deny
 *  is told in its words; then one message, main's resume message per call (resumeText), the session goes on with.
 *  "park": a call still waits (the run parks again, its ask asked again). Undefined: nothing waits. A call a follow-up
 *  already answered (its resume message on the record) is not answered again. */
export async function parkedFollowUp(mcp: ClaimMcp, options: ParkedFollowUpOptions): Promise<{ text: string; callIds: string[] } | "park" | undefined> {
  const said = new Set<string>();
  for (const entry of options.entries) {
    const text = (entry.data as { text?: unknown } | null)?.text;
    if (entry.kind === KINDS.message && typeof text === "string" && text.startsWith(RESUME_PREFIX)) said.add(text);
  }
  const answered = (callId: string) => [...said].some((text) => text.includes(` call ${callId} `));
  const ended = new Map<string, CallEndData>();
  for (const entry of options.entries) if (entry.kind === KINDS.callEnd) ended.set((entry.data as CallEndData).callId, entry.data as CallEndData);
  const texts: string[] = [];
  const callIds: string[] = [];
  const asked = new Set<string>();
  for (const entry of options.entries) {
    if (entry.kind !== KINDS.ask) continue;
    const ask = entry.data as AskData;
    if (asked.has(ask.callId) || mcp.priceOf(ask.tool) === undefined || answered(ask.callId)) continue;
    asked.add(ask.callId);
    const call: McpGateCall = { callId: ask.callId, tool: ask.tool, args: (ask.args ?? {}) as Record<string, unknown> };
    const answer = await options.answer(call, ask.price ?? null);
    if (answer === "park") return "park";
    let result: { text: string; isError?: boolean };
    if (!answer.approved) result = { text: deniedText(call.tool, answer.note), isError: true };
    else {
      const done = ended.get(call.callId);
      const denied = await options.deniedNow(call);
      result = done ? { text: typeof done.output === "string" ? done.output : `The ${call.tool} call ended ${done.status}.`, isError: done.status !== "done" } : denied !== undefined ? { text: denied, isError: true } : await options.run(call);
    }
    texts.push(resumeText({ tool: call.tool, call_id: call.callId }, argsPreview(call.args), answer.approved ? "allow" : "deny", { text: result.text, isError: result.isError === true }));
    callIds.push(call.callId);
  }
  return texts.length ? { text: texts.join("\n\n"), callIds } : undefined;
}
