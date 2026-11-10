// Connecting an account to a Composio toolkit in one click (the source's `connect`): Composio's managed OAuth app for the
// toolkit (its "use_composio_managed_auth" auth config, found or made once), then a link that sends the person to sign
// in. The connection is Composio's to hold (custody oauth, holder provider): this side keeps only its id. Shared with
// Composio's triggers, which listen on a connection made here. Each failure throws in words: a connection is made from the
// console, never mid-run.
import { composioCall } from "./client.ts";
import type { Ctx } from "./protocol-draft.ts";

/** The Composio user every connection made here belongs to: one per server (settings COMPOSIO_USER_ID), so a run's call
 *  and a trigger name the same user as the connection they use. */
export const DEFAULT_USER_ID = "agentrun";
export const userIdOf = (ctx: Ctx): string => ctx.settings.COMPOSIO_USER_ID?.trim() || DEFAULT_USER_ID;

export type ConnectionState = "pending" | "active" | "expired" | "revoked" | "failed";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;

/** A toolkit's slug from its id (`composio:<slug>`) or the slug itself; refused unless it reads as one. */
export function slugOf(toolkit: string): string {
  const slug = toolkit.startsWith("composio:") ? toolkit.slice("composio:".length) : toolkit;
  if (!SLUG.test(slug)) throw new Error(`${toolkit} is not a Composio toolkit (its slug is lowercase letters, digits, _ and -).`);
  return slug;
}

/** The toolkit's auth config on Composio's managed OAuth app: one already on the project, else one made now. */
async function managedAuthConfig(slug: string, ctx: Ctx): Promise<string> {
  const listed = await composioCall(ctx, "GET", "/auth_configs", { query: { toolkit_slug: slug, limit: "100" } });
  if (!listed.ok) throw new Error(`Composio's auth configs for ${slug} could not be read: ${listed.words}`);
  const items = isObject(listed.json) && Array.isArray(listed.json.items) ? listed.json.items : [];
  const found = items.find((item) => isObject(item) && item.is_composio_managed === true && item.is_disabled !== true && isObject(item.toolkit) && item.toolkit.slug === slug && typeof item.id === "string");
  if (found) return (found as { id: string }).id;
  const made = await composioCall(ctx, "POST", "/auth_configs", { body: { toolkit: { slug }, auth_config: { type: "use_composio_managed_auth" } } });
  if (!made.ok) throw new Error(`Composio's managed sign-in for ${slug} could not be set up: ${made.words}`);
  const id = isObject(made.json) && isObject(made.json.auth_config) ? made.json.auth_config.id : undefined;
  if (typeof id !== "string" || !id) throw new Error(`Composio set up ${slug}'s managed sign-in but gave no auth config id.`);
  return id;
}

/** Starts a connection to `toolkit`: the URL the person signs in at, the connection's id, and when the link expires. */
export async function start(toolkit: string, ctx: Ctx): Promise<{ url: string; connectionRef: string; expiresAt: string }> {
  const slug = slugOf(toolkit);
  const authConfig = await managedAuthConfig(slug, ctx);
  const linked = await composioCall(ctx, "POST", "/connected_accounts/link", { body: { auth_config_id: authConfig, user_id: userIdOf(ctx) } });
  if (!linked.ok) throw new Error(`Composio could not start a connection to ${slug}: ${linked.words}`);
  const json = isObject(linked.json) ? linked.json : {};
  const { redirect_url: url, connected_account_id: connectionRef, expires_at: expiresAt } = json;
  if (typeof url !== "string" || typeof connectionRef !== "string" || typeof expiresAt !== "string") throw new Error(`Composio started a connection to ${slug} but its answer had no sign-in URL, connection id or expiry.`);
  // The person is sent to the URL Composio gave: an https one alone.
  if (new URL(url).protocol !== "https:") throw new Error(`Composio's sign-in URL for ${slug} is not https; it was not used.`);
  return { url, connectionRef, expiresAt };
}

/** Composio's statuses, in the protocol's words. One this list does not know reads as pending: never as active. */
const STATES: Record<string, ConnectionState> = { ACTIVE: "active", INITIALIZING: "pending", INITIATED: "pending", EXPIRED: "expired", INACTIVE: "revoked", FAILED: "failed" };

/** Where the connection `ref` stands: a connection Composio no longer has is revoked. */
export async function status(ref: string, ctx: Ctx): Promise<ConnectionState> {
  const read = await composioCall(ctx, "GET", `/connected_accounts/${encodeURIComponent(ref)}`, { account: true });
  if (!read.ok) {
    if (read.status === 404) return "revoked";
    throw new Error(`Composio's connection ${ref} could not be read: ${read.words}`);
  }
  const state = isObject(read.json) && typeof read.json.status === "string" ? read.json.status : "";
  return STATES[state] ?? "pending";
}

/** The connection `ref` deleted at Composio; one already gone is done. */
export async function revoke(ref: string, ctx: Ctx): Promise<void> {
  const gone = await composioCall(ctx, "DELETE", `/connected_accounts/${encodeURIComponent(ref)}`, { account: true });
  if (!gone.ok && gone.status !== 404) throw new Error(`Composio's connection ${ref} could not be removed: ${gone.words}`);
}
