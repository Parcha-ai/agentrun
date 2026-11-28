import {cliLearningOf} from "./store/agent-body.js";
// A revision saved with no MCP pin (before pins were made at save, or an inline agent's version stored then) is pinned
// once, at its first run, as a save would pin it: each granted server still saved here listed once
// (McpServersOverStore.pinListing, the save's own listing), the pin made of those listings (mcp-gateway.ts mcpPinOf), and
// written only while the revision still has none (Agents.pinOnce), the pin that stood read back. One path for a run's
// start (server.ts, before runnable) and a run's claim (runner/mcp-claim.ts, for a run that already existed when the
// store was upgraded): two first runs, or a start and a claim, at once agree on one pin. Nothing moves from a run's old
// per-run pin (mcp_pins, dropped at the upgrade): the revision's pin is the one every run of it reads.
import { readFile } from "node:fs/promises";
import { nativeOf } from "./native/binding.js";
import { sdkOf } from "./sdk/runs.js";
import { type McpPin, mcpPinOf } from "./mcp-gateway.js";
import type { OAuthNetwork } from "./mcp-oauth.js";
import { boundTool } from "./mcp-probe.js";
import { type McpServersOverStore, mcpServersOverStore } from "./mcp-servers-store.js";
import { SEAL_KEY_ENV } from "./tool-keys.js";
import { mcpNameOf } from "./tool-names.js";
import { type GithubAppAccess, GITHUB_UNUSABLE } from "./runner/mcp-github.js";

/** One server's listing as a save pins it (McpServersOverStore.pinListing); undefined when no such server is saved. */
export type PinListing = Awaited<ReturnType<McpServersOverStore["pinListing"]>>;

export interface PinFirstDeps {
  /** Whether a server of this name is saved here: a grant of one that is not leaves the revision unpinned, to the run's
   *  own refusal, so the pin is made whole once the server is saved again. */
  saved(server: string): boolean | Promise<boolean>;
  /** The server's listing now, as a save lists it; throws when it can't be listed. */
  pinListing(server: string): Promise<PinListing>;
  /** Agents.pinOnce: `pin` written only while the revision has none; the pin it has then. */
  pinOnce(revisionId: string, pin: McpPin): Promise<unknown>;
}

/** The revision's MCP pin: its own when it has one; else, when every server it grants a tool of is saved here and lists
 *  it, the pin made now of all of them and kept on it (or the one another first run kept first). Undefined when it grants
 *  none, or when one such server is not saved, can't be listed or no longer lists a granted tool: nothing is written (a
 *  pin of the other servers alone would stand for good, its missing tool never pinned), and the run is refused in the
 *  words it was (server.ts runnable at a start, the claim's own at a claim). */
export async function pinFirst(revision: { readonly id: string; readonly kind: string; readonly body: unknown; readonly mcpPin?: unknown }, deps: PinFirstDeps): Promise<McpPin | undefined> {
  // Native source MCP names and SDK callback tools belong to their source, never this server's managed registry.
  // Their runnable guards must refuse managed execution without listing or pinning those names first.
  if (nativeOf(revision.body) || sdkOf(revision.body) || cliLearningOf(revision.body)) return undefined;
  if (revision.mcpPin !== undefined && revision.mcpPin !== null) return revision.mcpPin as McpPin;
  if (revision.kind !== "agentic") return undefined;
  const granted: string[] = [];
  for (const tool of (revision.body as { tools?: readonly string[] }).tools ?? []) {
    const named = mcpNameOf(tool);
    if (!named) continue;
    if (!(await deps.saved(named.server))) return undefined;
    granted.push(tool);
  }
  if (!granted.length) return undefined;
  const listings = new Map<string, NonNullable<PinListing>>();
  try {
    await Promise.all([...new Set(granted.map((tool) => mcpNameOf(tool)!.server))].map(async (server) => {
      const listing = await deps.pinListing(server);
      if (!listing) throw new Error(`${server} is no longer saved`);
      listings.set(server, listing);
    }));
  } catch {
    return undefined;
  }
  let pin: McpPin;
  try {
    pin = mcpPinOf(granted, { server: (name) => { const listing = listings.get(name); return listing && { url: listing.url, tools: listing.tools.map(boundTool), prices: listing.prices, toolkit: listing.toolkit }; } });
  } catch {
    return undefined;
  }
  if (!Object.keys(pin).length) return undefined;
  return ((await deps.pinOnce(revision.id, pin)) ?? undefined) as McpPin | undefined;
}

/** A runner's pinListing (PinFirstDeps): the owner's registry over the one store, opened with the runner's seal key (the
 *  server's) on the first listing it is asked for, loopback allowed only for a runner beside a local install, never to
 *  that server's own ports (`own`, Serve.own). `githubApp`:
 *  the run's GitHub App access (runner/mcp-github.ts), which lists a `github_app` server with a token of the run's
 *  repository, metadata read alone, as a save lists it with one (github-connection.ts tokenForListing); without it such a
 *  server can't be listed. `appOrigin`: a test's fake GitHub MCP (McpServersOverStore.appOrigin). `composioOrigin`: a
 *  test's fake Composio MCP (McpServersOverStore.composioOrigin). */
export function registryListing(store: Parameters<typeof mcpServersOverStore>[0], sealKey: Buffer, { loopback = false, own = [], network, githubApp, appOrigin, composioOrigin }: { loopback?: boolean; own?: readonly string[]; network?: OAuthNetwork; githubApp?: GithubAppAccess; appOrigin?: string; composioOrigin?: string } = {}): (server: string, stop?: AbortSignal) => Promise<PinListing> {
  let registry: Promise<McpServersOverStore> | undefined;
  // The listing tokens minted and not yet revoked, and how many listings are under way: no one holds a listing token
  // after its listing (the claim's cleanup reaches only githubTokens' tokens), so once no listing is under way, each is
  // revoked at GitHub, whether the listing answered or failed.
  const minted: string[] = [];
  let listing = 0;
  const open = async () => {
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const opened = mcpServersOverStore(store, { [SEAL_KEY_ENV]: sealKey.toString("base64") }, version, network);
    opened.attach("", "", loopback, own);
    if (appOrigin) opened.appOrigin = appOrigin;
    if (composioOrigin) opened.composioOrigin = composioOrigin;
    if (githubApp) opened.appToken = async () => {
      const got = await listingToken(githubApp);
      if ("token" in got) minted.push(got.token);
      return got;
    };
    return opened;
  };
  return async (server, stop) => {
    listing += 1;
    try {
      return await (await (registry ??= open())).pinListing(server, stop);
    } finally {
      listing -= 1;
      if (!listing) await Promise.all(minted.splice(0).map((token) => githubApp?.revoke?.(token).catch(() => undefined)));
    }
  };
}

/** A token to list a github_app server's tools with, from the run's App access: its repository, metadata read alone; or
 *  why there is none, in the words its calls would be refused in. */
async function listingToken(access: GithubAppAccess): Promise<{ token: string } | { unusable: string } | { failed: string }> {
  if (access.withheld) return { unusable: access.withheld };
  if (!access.target) return { unusable: GITHUB_UNUSABLE.noRepo };
  const minted = await access.mint(access.target, { metadata: "read" });
  if (minted.ok) return { token: minted.token };
  return minted.reason === "github_failed" ? { failed: minted.message } : { unusable: minted.message };
}
