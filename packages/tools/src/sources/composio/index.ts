// Composio as a tool source (tools-protocol §2.4): a toolkit is `composio:<toolkit>` (gmail), an action
// `composio:<toolkit>/<ACTION>` (GMAIL_SEND_EMAIL). Each action runs by itself through Composio's direct execute
// (POST /tools/execute/{slug}), never a session or a meta tool (ruling A: our gate decides every action), at the version
// pinned when it was granted: never "latest", and every call names its version. Every action is asked by default (the
// kernel's catalog default) and is labelled "not metered": its cost, if any, is Composio's, never known here. The key is
// Composio's, sent to its origin alone (client.ts); a toolkit's account is connected through Composio's managed OAuth app
// (connect.ts), which holds the account's tokens.
import { COMPOSIO_ORIGIN, composioCall, EXECUTE_MS, scrubbed } from "./client.ts";
import { revoke, start, status, userIdOf } from "./connect.ts";
import type { ActionSpec, CallCtx, CallOutcome, Ctx, Risk, Toolkit, ToolSource } from "./protocol-draft.ts";

/** A pinned version: Composio's dated toolkit version (`20250909_00`), never "latest". */
export const PINNED_VERSION = /^\d{8}_\d{2}$/;
/** The most of an action's answer the kernel keeps in the run's context; the whole answer is filed. */
export const RESULT_MAX_CHARS = 60_000;
/** Composio's own toolkit: its tools are meta tools (search, multi-execute, a remote shell), never granted (ruling A). */
export const META_TOOLKIT = "composio";
const SLUG = /^[A-Za-z0-9_]{1,200}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** An action's risk from Composio's tags (its tools carry MCP's annotation names as tags): a claim of Composio's, which
 *  the owner may mark otherwise. With neither hint, unknown, a write. */
function riskOf(tags: unknown): Risk {
  const said = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
  if (said.includes("destructiveHint")) return { level: "destructive", from: "source_hint" };
  if (said.includes("readOnlyHint")) return { level: "read", from: "source_hint" };
  return { level: "write", from: "unknown" };
}

/** One of Composio's tool items as the action it is granted as, its version pinned. One with no dated version, or one of
 *  Composio's meta tools, is listed but never grantable. */
export function specOf(item: Record<string, unknown>): ActionSpec | undefined {
  const slug = typeof item.slug === "string" && SLUG.test(item.slug) ? item.slug : undefined;
  const toolkit = isObject(item.toolkit) && typeof item.toolkit.slug === "string" ? item.toolkit.slug : undefined;
  if (!slug || !toolkit) return undefined;
  const version = typeof item.version === "string" ? item.version : "";
  const grantable = toolkit === META_TOOLKIT
    ? { reason: `${slug} is one of Composio's meta tools, which run other actions out of the gate's sight: grant the actions themselves.` }
    : !PINNED_VERSION.test(version)
      ? { reason: `Composio gave ${slug} no fixed version (${version || "none"}), so it can't be pinned.` }
      : true as const;
  return {
    id: `composio:${toolkit}/${slug}`,
    title: typeof item.name === "string" && item.name ? item.name : slug,
    description: typeof item.description === "string" ? item.description : "",
    inputSchema: isObject(item.input_parameters) ? item.input_parameters : { type: "object" },
    ...(isObject(item.output_parameters) ? { outputSchema: item.output_parameters } : {}),
    risk: riskOf(item.tags),
    price: { kind: "not_metered" },
    // A call that may have reached the app (a mail sent) is never sent again: its result is lost, not retried.
    replay: "never",
    // The key goes to Composio's origin; the account's tokens stay with Composio. The grant names the connection.
    custody: item.no_auth === true ? { kind: "sealed_key", keyRef: "COMPOSIO_API_KEY", boundTo: COMPOSIO_ORIGIN } : { kind: "oauth", holder: "provider", connectionRef: "", boundTo: COMPOSIO_ORIGIN },
    resultMaxChars: RESULT_MAX_CHARS,
    grantable,
    version,
  };
}

/** Every tool item `query` lists, page by page (Composio's cursor), at most `pages` pages. */
async function toolItems(ctx: Ctx, query: Record<string, string | undefined>, pages = 20): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < pages; page++) {
    const listed = await composioCall(ctx, "GET", "/tools", { query: { ...query, limit: "1000", ...(cursor ? { cursor } : {}) } });
    if (!listed.ok) throw new Error(`Composio's tools could not be listed: ${listed.words}`);
    const json = isObject(listed.json) ? listed.json : {};
    for (const item of Array.isArray(json.items) ? json.items : []) if (isObject(item)) items.push(item);
    cursor = typeof json.next_cursor === "string" && json.next_cursor ? json.next_cursor : undefined;
    if (!cursor) break;
  }
  return items;
}

const toolkitSlug = (id: string): string => {
  const slug = id.startsWith("composio:") ? id.slice("composio:".length) : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(slug)) throw new Error(`${id} is not a Composio toolkit id (composio:<toolkit>).`);
  return slug;
};

/** An action's call refused before anything was sent: nothing charged. */
const unsent = (text: string, refusal: CallOutcome["refusal"]): CallOutcome => ({ text, isError: true, ...(refusal ? { refusal } : {}) });

export const composio: ToolSource = {
  id: "composio",
  label: "Composio",
  caps: {
    connect: true,
    search: true,
    quote: { unsupported: "Composio does not say what an action costs before it runs: its actions are not metered here." },
    recover: { unsupported: "Composio has no way to read back an action that was cut off, so one is never sent again." },
    triggers: { unsupported: "Composio's triggers are their own work item (TP-13)." },
  },
  settings: { fields: [{ name: "COMPOSIO_API_KEY", secret: true }, { name: "COMPOSIO_USER_ID", secret: false }] },

  /** Listing one toolkit, which Composio does not charge for: the key works, is refused, or can't be told now. */
  async check(ctx) {
    const listed = await composioCall(ctx, "GET", "/toolkits", { query: { limit: "1" } });
    if (listed.ok) return { state: "ok", words: "Composio accepted the key." };
    if (listed.refusal === "key_refused") return { state: "refused", words: listed.words };
    return { state: "unknown", words: listed.words };
  },

  async toolkits(ctx, query) {
    const listed = await composioCall(ctx, "GET", "/toolkits", { query: { limit: "1000", ...(query ? { search: query } : {}) } });
    if (!listed.ok) throw new Error(`Composio's toolkits could not be listed: ${listed.words}`);
    const items = isObject(listed.json) && Array.isArray(listed.json.items) ? listed.json.items : [];
    return items.flatMap((item): Toolkit[] => {
      if (!isObject(item) || typeof item.slug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(item.slug)) return [];
      const meta = isObject(item.meta) ? item.meta : {};
      return [{ id: `composio:${item.slug}`, label: typeof item.name === "string" && item.name ? item.name : item.slug, actions: typeof meta.tools_count === "number" ? meta.tools_count : "unknown", needsConnection: item.no_auth !== true }];
    });
  },

  /** The toolkit's actions as they are now, each pinned to the version Composio names it at (the grant keeps that).
   *  `only`: just these actions, by their slug. */
  async actions(toolkit, ctx, only) {
    const slug = toolkitSlug(toolkit);
    const items = await toolItems(ctx, { toolkit_slug: slug, ...(only?.length ? { tool_slugs: only.join(",") } : {}) });
    return items.flatMap((item) => {
      const spec = specOf(item);
      return spec && spec.id.startsWith(`composio:${slug}/`) && (!only?.length || only.includes(spec.id.slice(spec.id.indexOf("/") + 1))) ? [spec] : [];
    });
  },

  async search(query, ctx) {
    const items = await toolItems(ctx, { query }, 1);
    return items.flatMap((item) => (specOf(item) ? [specOf(item)!] : []));
  },

  /** One action, by Composio's direct execute at its pinned version, on the grant's connection. Never throws: every
   *  failure is the answer, in words. */
  async call(spec, args, ctx: CallCtx): Promise<CallOutcome> {
    const slug = spec.id.slice(spec.id.indexOf("/") + 1);
    if (!spec.id.startsWith("composio:") || !SLUG.test(slug)) return unsent(`${spec.id} is not a Composio action; nothing was sent.`, "unsupported");
    if (spec.grantable !== true) return unsent(`${spec.id} can't be run: ${spec.grantable.reason} Nothing was sent.`, "unsupported");
    // Never "latest": the call names the version the grant pinned.
    if (!PINNED_VERSION.test(spec.version)) return unsent(`${spec.id} has no pinned version (${spec.version || "none"}); nothing was sent.`, "unsupported");
    if (!ctx.credential) return unsent("No Composio key is saved here: save one in Settings, then try again. Nothing was sent.", "key_refused");
    const connection = spec.custody.kind === "oauth" ? ctx.credential.connection() : "";
    if (spec.custody.kind === "oauth" && !connection) return unsent(`${spec.id} needs a connected ${spec.id.slice("composio:".length, spec.id.indexOf("/"))} account: connect one in Settings, then grant it. Nothing was sent.`, "needs_connection");
    const key = ctx.credential.header("x-api-key")[1];
    const ran = await composioCall(ctx, "POST", `/tools/execute/${slug}`, {
      body: { ...(connection ? { connected_account_id: connection } : {}), user_id: userIdOf(ctx), version: spec.version, arguments: isObject(args) ? args : {} },
      ms: EXECUTE_MS,
      account: spec.custody.kind === "oauth",
    });
    if (!ran.ok) return { text: ran.words, isError: true, refusal: ran.refusal, ...(ran.sent ? { chargedUsd: null } : {}) };
    const json = isObject(ran.json) ? ran.json : {};
    const ref = typeof json.log_id === "string" ? { upstreamRef: json.log_id } : {};
    // Not metered: whatever Composio charges is not known here, so never booked as nothing.
    if (json.successful !== true) {
      const error = typeof json.error === "string" && json.error ? json.error : "the action did not succeed";
      return { text: scrubbed(`${spec.title} failed: ${error}`, [key]), isError: true, refusal: "upstream_error", chargedUsd: null, ...ref };
    }
    return { text: scrubbed(JSON.stringify(json.data ?? null), [key]), isError: false, chargedUsd: null, ...ref };
  },

  connect: { start, status, revoke },
};
