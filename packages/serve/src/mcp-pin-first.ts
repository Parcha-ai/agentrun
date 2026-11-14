// A revision saved with no MCP pin (before pins were made at save, or an inline agent's version stored then) is pinned
// once, at its first run, as a save would pin it: each granted server still saved here listed once
// (McpServersOverStore.pinListing, the save's own listing), the pin made of those listings (mcp-gateway.ts mcpPinOf), and
// written only while the revision still has none (Agents.pinOnce), the pin that stood read back. One path for a run's
// start (server.ts, before runnable) and a run's claim (runner/mcp-claim.ts, for a run that already existed when the
// store was upgraded): two first runs, or a start and a claim, at once agree on one pin. Nothing moves from a run's old
// per-run pin (mcp_pins, dropped at the upgrade): the revision's pin is the one every run of it reads.
import { readFile } from "node:fs/promises";
import { type McpPin, mcpPinOf } from "./mcp-gateway.js";
import type { OAuthNetwork } from "./mcp-oauth.js";
import { boundTool } from "./mcp-probe.js";
import { type McpServersOverStore, mcpServersOverStore } from "./mcp-servers-store.js";
import { SEAL_KEY_ENV } from "./tool-keys.js";
import { mcpNameOf } from "./tool-names.js";

/** One server's listing as a save pins it (McpServersOverStore.pinListing); undefined when no such server is saved. */
export type PinListing = Awaited<ReturnType<McpServersOverStore["pinListing"]>>;

export interface PinFirstDeps {
  /** Whether a server of this name is saved here: a grant of one that is not is left to the run's own refusal. */
  saved(server: string): boolean | Promise<boolean>;
  /** The server's listing now, as a save lists it; throws when it can't be listed. */
  pinListing(server: string): Promise<PinListing>;
  /** Agents.pinOnce: `pin` written only while the revision has none; the pin it has then. */
  pinOnce(revisionId: string, pin: McpPin): Promise<unknown>;
}

/** The revision's MCP pin: its own when it has one; else, when it grants a tool of a server saved here, the pin made now
 *  and kept on it (or the one another first run kept first). Undefined when it grants none, or when a server can't be
 *  listed or no longer lists a granted tool: nothing is written, and the run is refused in the words it was (server.ts
 *  runnable at a start, the claim's own at a claim). */
export async function pinFirst(revision: { readonly id: string; readonly kind: string; readonly body: unknown; readonly mcpPin?: unknown }, deps: PinFirstDeps): Promise<McpPin | undefined> {
  if (revision.mcpPin !== undefined && revision.mcpPin !== null) return revision.mcpPin as McpPin;
  if (revision.kind !== "agentic") return undefined;
  const granted: string[] = [];
  for (const tool of (revision.body as { tools?: readonly string[] }).tools ?? []) {
    const named = mcpNameOf(tool);
    if (named && (await deps.saved(named.server))) granted.push(tool);
  }
  if (!granted.length) return undefined;
  const listings = new Map<string, NonNullable<PinListing>>();
  try {
    await Promise.all([...new Set(granted.map((tool) => mcpNameOf(tool)!.server))].map(async (server) => {
      const listing = await deps.pinListing(server);
      if (listing) listings.set(server, listing);
    }));
  } catch {
    return undefined;
  }
  let pin: McpPin;
  try {
    pin = mcpPinOf(granted, { server: (name) => { const listing = listings.get(name); return listing && { url: listing.url, tools: listing.tools.map(boundTool), prices: listing.prices }; } });
  } catch {
    return undefined;
  }
  if (!Object.keys(pin).length) return undefined;
  return ((await deps.pinOnce(revision.id, pin)) ?? undefined) as McpPin | undefined;
}

/** A runner's pinListing (PinFirstDeps): the owner's registry over the one store, opened with the runner's seal key (the
 *  server's) on the first listing it is asked for, loopback allowed only for a runner beside a local install. */
export function registryListing(store: Parameters<typeof mcpServersOverStore>[0], sealKey: Buffer, { loopback = false, network }: { loopback?: boolean; network?: OAuthNetwork } = {}): (server: string, stop?: AbortSignal) => Promise<PinListing> {
  let registry: Promise<McpServersOverStore> | undefined;
  const open = async () => {
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const opened = mcpServersOverStore(store, { [SEAL_KEY_ENV]: sealKey.toString("base64") }, version, network);
    opened.attach("", "", loopback);
    return opened;
  };
  return async (server, stop) => (await (registry ??= open())).pinListing(server, stop);
}
