// A claimed run's remote MCP servers on the runner (tl-mcp's note, sections 4 to 6). A spec builder calls mcpForClaim once
// per claim, inside the adapter loop's spec step: after the loop's Gate and Harness are open, before its session. It runs
// the claim step (mcp-claim.ts: the pin made at the first claim or read as written, checked against the meta tools known
// now, the pinned servers' credentials opened into this claim's memory) and builds ONE gateway (mcp-gateway.ts) for the
// claim, never shared with another, reading those credentials live. The builder puts what it returns in its spec
// (AdapterRunSpec.mcp); the loop does the rest:
// - one host tool per pinned tool (`tools`), under its wire name with the pinned description and schema, for every
//   harness: the loop hands them to the session as it hands every host tool (pi's registry, the CLIs' own channel for
//   host tools), on its path for every host tool: the gate before the intent (allow, ask and park, deny), the flush, the
//   record, the run's one ledger for a priced call.
// - a command row handed to the running loop makes the credentials fresh again (`fresh`, on the same pin) before its
//   next model request; the loop calls `release` when its pass ends, the claim is lost or its signal aborts.
// The gateway holds no gate here (the loop's is the run's one gate) and keeps the rest as it is: the meta refusal, the
// unopened refusal, the URL check per call, the scrub of each call's credentials held only while that call is out, prices
// on the run's one ledger and the not-metered booking on the run's root.
import type { HostTool } from "@parcha/agentrun-kernel";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { wireName } from "../catalog.js";
import { mcpGateway, type McpGatewayOptions } from "../mcp-gateway.js";
import { dialAt, mcpServerAt, type OAuthNetwork, systemNetwork } from "../mcp-oauth.js";
import { privateOAuthHosts } from "../mcp-private-hosts.js";
import type { Store, TriggerSettings } from "../store/index.js";
import { type ApprovalPrice, mcpToolName, type ToolEffect, toolEffect } from "../tool-gate.js";
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
  /** A test's fake GitHub MCP origin, handed to the claim step (mcpClaim's githubMcpOrigin): for tests only: no environment variable, flag or setting maps onto it; absent, GitHub's hosted MCP
   *  (github.ts GITHUB_MCP_ORIGIN). */
  readonly githubMcpOrigin?: string;
  /** Whether this runner may reach an MCP server whose URL is on loopback (AdapterSpecDeps.mcpLoopback): only a runner
   *  beside a local-install server is. Absent, never. */
  readonly loopback?: boolean;
  /** For tests: the authorization servers' network, a refresh's bound, the gateway's upstream fetch and bounds, and the
   *  timer a github_app token's refresh is armed on. */
  readonly network?: OAuthNetwork;
  readonly bounds?: { requestMs?: number; tries?: number };
  readonly fetch?: typeof fetch;
  readonly callBounds?: { callMs?: number; connectMs?: number };
  readonly githubTimer?: GithubTimer;
  /** Each credential value the claim opens, refreshes or mints, for the run's redactors (mcp-claim.ts `hold`). */
  readonly hold?: (values: string[]) => void;
}

/** A claim's MCP (AdapterRunSpec.mcp): what the loop reaches the gateway by, and the claim step's own hooks. */
export interface ClaimMcp {
  /** One host tool per pinned tool, under its wire name, on every harness. Each reaches the gateway only as the loop
   *  wraps it, behind the run's one gate (the gate before the intent); nothing else does. */
  readonly tools: readonly HostTool[];
  /** A pinned tool's catalog name (`mcp:<server>/<tool>`) by its wire name; undefined for any other tool. */
  catalogOf(tool: string): string | undefined;
  /** What an asked call of a pinned tool costs on its card (main's: its price, else "not metered"); undefined otherwise. */
  priceOf(name: string): ApprovalPrice | undefined;
  /** A pinned tool's effect (`mcp:<server>/<tool>`), by its annotations as the pin holds them (tool-gate.ts toolEffect):
   *  what the gate's "allow reads" and a destructive call's card read; never a later listing. Undefined for any other. */
  effectOf(name: string): ToolEffect | undefined;
  /** The claim step's credentials opened again on the same pin (an expired OAuth token refreshed), then the claim
   *  confirmed: before a resumed loop's next model request. */
  fresh(): Promise<void>;
  /** Drops every credential held: the pass ended, the claim is lost, or its signal aborted. */
  release(): void;
}

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
      ...(options.loopback ? { loopback: true } : {}),
      ...(githubApp ? { githubApp } : {}),
      ...(options.githubMcpOrigin ? { githubMcpOrigin: options.githubMcpOrigin } : {}),
      ...(options.githubTimer ? { githubTimer: options.githubTimer } : {}),
      ...(options.hold ? { hold: options.hold } : {}),
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
  const network = options.network ?? systemNetwork;
  const gateway = mcpGateway({
    pin,
    credentials: step.credentials,
    // Each request's address checked as the server checks it at a save (mcp-oauth.ts mcpServerAt), with the owner's
    // private-network hosts read now, and dialled at the address checked: a name that resolves somewhere private since the
    // save, or a host the owner no longer allows, is refused unsent. A URL on loopback is reached only by a runner told
    // so by the local-install server beside it, in its own process (options.loopback): never by what a store says, so
    // one host's local install never opens loopback for another host's runner on a shared store.
    reach: async (url, signal) => {
      const at = await mcpServerAt(new URL(url), signal, network, { allowed: await privateOAuthHosts(options.store), loopback: options.loopback === true });
      return "refused" in at ? { refused: at.refused } : { send: dialAt(network, at.address, options.fetch ?? fetch) as typeof fetch };
    },
    beforeCall: step.beforeCall,
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
    effectOf(name) {
      const parsed = /^mcp:([^/]+)\/(.+)$/.exec(name);
      const pinned = parsed && Object.hasOwn(pin, parsed[1]!) ? pin[parsed[1]!] : undefined;
      const tool = pinned?.tools.find((one) => one.name === parsed![2]);
      return tool ? toolEffect(tool.annotations) : undefined;
    },
    fresh: () => step.fresh(),
    release: () => held.abort(),
  };
}
