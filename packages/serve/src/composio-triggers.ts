// Composio triggers set up from here: what a saved Composio server (composio-preset.ts) makes and keeps on Composio for
// the triggers of kind `composio` (trigger-composio.ts), with its saved key, and the routes that read it for the console.
// - The project's one webhook subscription (Composio allows one a project, and answers a second create 409) is made the
//   first time a trigger needs it, at this server's address /v2/hooks/composio/{hook}, its secret sealed under the hook's
//   scope (the trigger kernel's sealed settings, beside the server's key: never answered, logged or put in an event), and
//   reused after; every answer of Composio's carries the secret, so a reuse keeps the one it reads. One at someone else's
//   address is refused, naming it, unless the create asks to move it here.
// - A trigger's instance is Composio's, made by upsert for the account the server is connected as (none: refused with
//   the link to connect it; several: refused, naming each, never one picked). Triggers with the same server, event and config share Composio's one instance (its upsert
//   answers the same id): it is turned off only when every trigger holding it is off, and deleted with the last.
// - Making a trigger goes in order, subscription, instance, save, and a failure undoes what came before it. Pausing,
//   resuming and deleting follow on Composio once the change holds here, and so does the server turning a trigger off
//   itself (triggers.ts); what Composio could not do is said, with what to do by hand.
// - One project's steps run one at a time (serial): a create's setup, its save here and its undo, a pause, a delete. Each
//   reads the triggers holding what it would undo or turn off as they are then, so it never removes what another holds.
// No public address (AGENTRUN_PUBLIC_URL): Composio can't reach this server, so making one is refused before Composio is
// asked anything.
import { createHash, randomBytes } from "node:crypto";
import { ApiError, invalid } from "./errors.js";
import { type Ask, asking, type ComposioControl } from "./composio-preset.js";
import type { Source } from "./trigger-adapter.js";
import { COMPOSIO_HOOK, COMPOSIO_SECRET, MOVE_FIELD } from "./trigger-composio.js";
import type { TriggerUpstream } from "./triggers.js";
import { isObject, type Json } from "./validate.js";

/** Where the owner does by hand what this server could not do on Composio. */
const DASHBOARD = "https://platform.composio.dev";
/** The events the subscription sends: each trigger instance's. */
const EVENTS = ["composio.trigger.message"];
/** The payload version the subscription sends: V3 names the instance in metadata.trigger_id. */
const VERSION = "V3";
const PAGE = 100;
const MAX_PAGES = 10;

/** A saved Composio server's key, the Composio user its address names, and its toolkit. */
export type ComposioCredential = { key: string; user: string; toolkit: string };
/** What an instance comes to once a trigger no longer holds it (leftWith). */
type Left = "delete" | "off" | "keep";
/** A trigger of kind composio, as the engine keeps it. */
type Holder = { id: string; name: string; enabled: boolean; source: Source };
type Sealed = { get(scope: string, field: string): string | undefined; set(scope: string, field: string, value: string, as?: "utf8"): Promise<void>; remove(scope: string): Promise<void> };
type Subscription = { id: string; webhook_url: string; secret: string; enabled_events: string[] };

export type ComposioTriggerDeps = {
  control: ComposioControl;
  /** This server's public address, no trailing slash: the subscription's address starts with it. */
  publicUrl?: string;
  /** The composio source's sealed settings: each hook's subscription secret. */
  sealed: Sealed;
  /** Saved server `name`'s key, user and toolkit; refused (thrown) when it is no Composio server: by the source's field at
   *  a trigger's create (`field`), as a 404 on its own routes (`route`). */
  credential(name: string, refusal: "field" | "route"): Promise<ComposioCredential>;
  /** Every trigger of kind composio, on or off. */
  holders(): Promise<Holder[]>;
  signal?: AbortSignal;
  say(fields: Record<string, string>): void;
};

/** An event of a toolkit as the console's form reads it. */
export type ComposioEvent = { slug: string; name: string; description: string; instructions?: string; config: Json; polled: boolean };

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const enc = encodeURIComponent;
const newHook = () => `cph_${randomBytes(12).toString("hex")}`;
const instanceOf = (source: Source) => String(source.instance_id);

/** Whether two JSON values are equal, an object's fields in any order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}

/** A refusal of Composio's for a create's step, put on the source's field it is about: an event Composio has no such
 *  slug for, a config it refuses. Any other error as it is. */
function onField(error: unknown, field: string): unknown {
  if (!(error instanceof ApiError) || error.code !== "input_invalid") return error;
  const issue = error.extra.fields?.[0];
  return issue && (issue.field === "body" || issue.field === "toolkit") ? invalid([{ ...issue, field }]) : error;
}

export class ComposioTriggers implements TriggerUpstream {
  /** Each project's last step queued (serial), by a digest of its key. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: ComposioTriggerDeps) {}

  // ---- the trigger engine's (TriggerUpstream) ----------------------------------------------------------------------------

  async make<T>(source: Source, id: string, enabled: boolean, keep: (source: Source) => Promise<T>): Promise<T> {
    if (!this.deps.publicUrl) throw new ApiError("composio_no_public_url", "Composio can't reach this server: set its public URL first (AGENTRUN_PUBLIC_URL, the https address Composio sends events to), then make the trigger.");
    for (const field of ["instance_id", "hook"]) if (source[field] !== undefined) throw invalid([{ field: `source.${field}`, reason: "not_allowed", message: `${field} is set by this server when it makes the trigger on Composio: leave it out.` }]);
    const server = String(source.server);
    const credential = await this.deps.credential(server, "field");
    // Made, saved here, and undone when not saved, alone among the project's steps.
    return this.serial(credential.key, async () => {
      const ask = this.ask(credential, "nothing was saved");
      const undo: (() => Promise<void>)[] = [];
      try {
        // The account first: a read, so a server not connected yet leaves nothing made on Composio.
        const account = await this.accountOf(ask, credential, server);
        const hook = await this.subscribe(ask, source[MOVE_FIELD] === true, undo);
        const event = String(source.event);
        const made = await ask(`turning on ${event} on Composio`, "POST", `/api/v3/trigger_instances/${enc(event)}/upsert`, { connected_account_id: account, user_id: credential.user, trigger_config: source.config }, `Composio has no event ${event} for ${credential.toolkit}: pick one from the server's events.`).catch((error: unknown) => {
          throw onField(onField(error, "source.config"), "source.event");
        });
        const instance = text(made.trigger_id);
        if (!instance) throw new ApiError("upstream_failed", "Composio made no trigger instance: nothing was saved.");
        // Composio's one instance per server, event and config: the triggers already holding it keep it. Not kept, this
        // trigger leaves it as the triggers holding it then would (the upsert turned it on): deleted, off, or as it is.
        undo.push(async () => this.leave(ask, instance, await this.leftWith(instance, id)));
        if (!enabled && (await this.leftWith(instance, id)) !== "keep") await ask("turning the trigger instance off", "PATCH", `/api/v3/trigger_instances/manage/${enc(instance)}`, { status: "disable" });
        const { [MOVE_FIELD]: _moved, ...kept } = source;
        return await keep({ ...kept, instance_id: instance, hook });
      } catch (error) {
        for (const step of undo.splice(0).reverse()) await step().catch((undone: unknown) => this.deps.say({ condition: "composio_undo_failed", trigger: id, error: String((undone as Error)?.message ?? undone) }));
        throw error;
      }
    });
  }

  patched(was: Source, given: Source): Source {
    const fixed = "A Composio trigger's server, event and config made its instance on Composio, so they stay: make a new trigger for another.";
    for (const field of ["server", "event", "instance_id", "hook"]) if (given[field] !== undefined && given[field] !== was[field]) throw invalid([{ field: `source.${field}`, reason: "not_allowed", message: fixed }]);
    if (!same(given.config, was.config)) throw invalid([{ field: "source.config", reason: "not_allowed", message: fixed }]);
    if (given[MOVE_FIELD] !== undefined) throw invalid([{ field: `source.${MOVE_FIELD}`, reason: "not_allowed", message: `${MOVE_FIELD} is a create's alone.` }]);
    return { ...given, instance_id: was.instance_id, hook: was.hook };
  }

  async turned(source: Source, id: string, on: boolean): Promise<Json | undefined> {
    const instance = instanceOf(source);
    try {
      const credential = await this.deps.credential(String(source.server), "field");
      await this.serial(credential.key, async () => {
        // Off only once every trigger holding it is off.
        if (!on && (await this.leftWith(instance, id)) === "keep") return;
        await this.ask(credential)(`turning the trigger instance ${on ? "on" : "off"}`, "PATCH", `/api/v3/trigger_instances/manage/${enc(instance)}`, { status: on ? "enable" : "disable" });
      });
      return undefined;
    } catch (error) {
      this.deps.say({ condition: "composio_instance_not_turned", trigger: id, instance, on: String(on), error: String((error as Error)?.message ?? error) });
      return { composio: { done: false, note: `Composio didn't turn the trigger instance ${instance} ${on ? "on" : "off"}: turn it ${on ? "on" : "off"} there yourself: ${DASHBOARD}` } };
    }
  }

  async removed(source: Source, id: string): Promise<Json | undefined> {
    const instance = instanceOf(source);
    let left = "delete" as Left;
    try {
      // Kept while another trigger holds it, and off once none of those is on, as a pause leaves it.
      const credential = await this.deps.credential(String(source.server), "field");
      await this.serial(credential.key, async () => this.leave(this.ask(credential), instance, (left = await this.leftWith(instance, id))));
      return undefined;
    } catch (error) {
      const said = String((error as Error)?.message ?? error);
      if (left === "off") {
        this.deps.say({ condition: "composio_instance_not_turned", trigger: id, instance, on: "false", error: said });
        return { composio: { done: false, note: `Composio didn't turn the trigger instance ${instance} off, and no trigger left that holds it is on: turn it off there yourself: ${DASHBOARD}` } };
      }
      this.deps.say({ condition: "composio_instance_not_removed", trigger: id, instance, error: said });
      return { composio: { done: false, note: `Composio didn't delete the trigger instance ${instance}: remove it there yourself: ${DASHBOARD}` } };
    }
  }

  // ---- the routes of a saved Composio server ---------------------------------------------------------------------------

  /** GET /settings/mcp-servers/{name}/composio/events: its toolkit's events, every page. */
  async events(name: string): Promise<{ server: string; toolkit: string; events: ComposioEvent[] }> {
    const credential = await this.deps.credential(name, "route");
    const ask = this.ask(credential);
    const events: ComposioEvent[] = [];
    for (const item of await this.every(ask, "listing the toolkit's events", `/api/v3/triggers_types?toolkit_slugs=${enc(credential.toolkit)}`)) {
      if (!isObject(item) || !text(item.slug)) continue;
      const config = isObject(item.config) ? item.config : { type: "object", properties: {} };
      events.push({ slug: text(item.slug), name: text(item.name) || text(item.slug), description: text(item.description), ...(text(item.instructions) ? { instructions: text(item.instructions) } : {}), config, polled: item.type === "poll" });
    }
    return { server: name, toolkit: credential.toolkit, events };
  }

  /** GET /settings/mcp-servers/{name}/composio/triggers: its triggers, each with its instance's state on Composio, and
   *  whether the project's subscription is this server's. What Composio did not answer is `unknown`, and said. */
  async triggersOf(name: string): Promise<{ triggers: Json[]; subscription: Json | null; composio_error?: string }> {
    const credential = await this.deps.credential(name, "route");
    const mine = (await this.deps.holders()).filter((h) => h.source.server === name);
    const ask = this.ask(credential);
    let states: Map<string, "on" | "off"> | undefined;
    let subscription: Json | null = null;
    let failed: string | undefined;
    try {
      const sub = await this.subscriptionOf(ask);
      subscription = sub ? { ours: this.oursOf(sub.webhook_url) !== undefined, webhook_url: sub.webhook_url } : null;
      const ids = [...new Set(mine.map((h) => instanceOf(h.source)))];
      states = new Map();
      // A page's worth of ids asked at a time, each answer read to its last page.
      for (let i = 0; i < ids.length; i += PAGE) {
        const listed = await this.every(ask, "reading the trigger instances", `/api/v3/trigger_instances/active?trigger_ids=${ids.slice(i, i + PAGE).map(enc).join(",")}&show_disabled=true`);
        for (const item of listed) if (isObject(item) && text(item.id)) states.set(text(item.id), item.disabled_at ? "off" : "on");
      }
    } catch (error) {
      failed = String((error as Error)?.message ?? error);
    }
    const triggers = mine.map((h) => ({ id: h.id, name: h.name, enabled: h.enabled, event: h.source.event, instance_id: h.source.instance_id, on_composio: states ? (states.get(instanceOf(h.source)) ?? "missing") : "unknown" }));
    return { triggers, subscription, ...(failed ? { composio_error: failed } : {}) };
  }

  /** POST /settings/mcp-servers/{name}/composio/rotate-secret: the subscription's new secret, kept; none answered. */
  async rotate(name: string): Promise<{ rotated: true }> {
    const ask = this.ask(await this.deps.credential(name, "route"), "the old secret still signs");
    const sub = await this.subscriptionOf(ask);
    const hook = this.need(sub);
    const rotated = await ask("rotating the webhook subscription's secret", "POST", `/api/v3/webhook_subscriptions/${enc(sub!.id)}/rotate_secret`);
    const secret = text(rotated.secret);
    if (!secret) throw new ApiError("upstream_failed", "Composio gave no new secret: the old one still signs.");
    await this.keep(hook, secret);
    this.deps.say({ condition: "composio_secret_rotated", server: name, hook });
    return { rotated: true };
  }

  /** DELETE /settings/mcp-servers/{name}/composio/subscription: the project's subscription deleted on Composio, and its
   *  secret here; refused while a trigger uses it. */
  async forget(name: string): Promise<{ deleted: true }> {
    const ask = this.ask(await this.deps.credential(name, "route"));
    const sub = await this.subscriptionOf(ask);
    const hook = this.need(sub);
    const using = (await this.deps.holders()).filter((h) => h.source.hook === hook);
    if (using.length) throw new ApiError("composio_in_use", `The project's webhook subscription is used by ${using.map((h) => h.name).join(", ")}: delete ${using.length > 1 ? "them" : "it"} first.`, { details: { triggers: using.map((h) => ({ id: h.id, name: h.name })) } });
    await ask("deleting the webhook subscription", "DELETE", `/api/v3/webhook_subscriptions/${enc(sub!.id)}`);
    await this.deps.sealed.remove(hook);
    return { deleted: true };
  }

  /** The triggers that use saved server `name`: a server that has any is not deleted (refused, naming them). */
  async inUse(name: string): Promise<void> {
    const using = (await this.deps.holders()).filter((h) => h.source.server === name);
    if (using.length) throw new ApiError("composio_in_use", `${name} has Composio triggers: ${using.map((h) => h.name).join(", ")}. Delete ${using.length > 1 ? "them" : "it"} first, then the server.`, { details: { triggers: using.map((h) => ({ id: h.id, name: h.name })) } });
  }

  // ---- its steps ---------------------------------------------------------------------------------------------------------

  /** `step` run once the steps queued before it for the project of key `key` are done (failed or not), and before any
   *  queued after it. The key is digested, never kept as it is. */
  private serial<T>(key: string, step: () => Promise<T>): Promise<T> {
    const project = createHash("sha256").update(key).digest("hex");
    const ran = (this.queues.get(project) ?? Promise.resolve()).then(step);
    const done = ran.then(() => undefined, () => undefined);
    this.queues.set(project, done);
    void done.then(() => {
      if (this.queues.get(project) === done) this.queues.delete(project);
    });
    return ran;
  }

  /** Every item a listing answers at `path` (with a query already), page after page by next_cursor, up to MAX_PAGES. */
  private async every(ask: Ask, step: string, path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await ask(step, "GET", `${path}&limit=${PAGE}${cursor ? `&cursor=${enc(cursor)}` : ""}`);
      items.push(...(Array.isArray(listed.items) ? listed.items : []));
      cursor = text(listed.next_cursor) || undefined;
      if (!cursor) break;
    }
    return items;
  }

  /** What instance `instance` comes to once trigger `id` no longer holds it, by the triggers holding it now: deleted when
   *  none does; off when none of them is on, so Composio stops polling for it; else kept as it is. */
  private async leftWith(instance: string, id: string): Promise<Left> {
    const others = (await this.deps.holders()).filter((h) => h.id !== id && h.source.instance_id === instance);
    return !others.length ? "delete" : others.some((h) => h.enabled) ? "keep" : "off";
  }

  /** Instance `instance` deleted on Composio or turned off, as `left` says; Composio's 404 to the delete: already gone. */
  private async leave(ask: Ask, instance: string, left: Left): Promise<void> {
    const manage = `/api/v3/trigger_instances/manage/${enc(instance)}`;
    if (left === "off") await ask("turning the trigger instance off", "PATCH", manage, { status: "disable" });
    if (left !== "delete") return;
    await ask("deleting the trigger instance", "DELETE", manage, undefined, "gone").catch((error: unknown) => {
      if (!(error instanceof ApiError && error.extra.fields?.[0]?.reason === "not_found")) throw error;
    });
  }

  /** Composio asked with the server's key; a failure's words end with what it left (`outcome`). */
  private ask(credential: ComposioCredential, outcome = "nothing was changed"): Ask {
    return asking(this.deps.control, credential.key, this.deps.signal, outcome);
  }

  private addressOf(hook: string): string {
    return `${this.deps.publicUrl}/v2/hooks/composio/${hook}`;
  }

  /** The hook an address's path names (/v2/hooks/composio/{hook}), whatever its origin. */
  private hookIn(url: string): string | undefined {
    try {
      const hook = /^\/v2\/hooks\/composio\/([^/]+)$/.exec(new URL(url).pathname)?.[1];
      return hook && COMPOSIO_HOOK.test(hook) ? hook : undefined;
    } catch {
      return undefined;
    }
  }

  /** The hook a subscription's address names when it is this server's: its public address, at a hook whose secret is
   *  kept here. Else undefined: someone else's. */
  private oursOf(url: string): string | undefined {
    const hook = this.hookIn(url);
    return hook && this.deps.publicUrl && url === this.addressOf(hook) && this.deps.sealed.get(hook, COMPOSIO_SECRET) !== undefined ? hook : undefined;
  }

  /** The hook of `sub` when it is this server's; refused when there is none, or it is someone else's. */
  private need(sub: Subscription | undefined): string {
    if (!sub) throw new ApiError("not_found", "This Composio project has no webhook subscription: making its first Composio trigger makes one.");
    const hook = this.oursOf(sub.webhook_url);
    if (!hook) throw new ApiError("composio_subscription_elsewhere", `This Composio project's webhook subscription sends its events to ${sub.webhook_url}, not to this server.`, { details: { webhook_url: sub.webhook_url } });
    return hook;
  }

  private async subscriptionOf(ask: Ask): Promise<Subscription | undefined> {
    const listed = await ask("reading the project's webhook subscription", "GET", "/api/v3/webhook_subscriptions");
    const item = (Array.isArray(listed.items) ? listed.items : []).find((i) => isObject(i) && text(i.id));
    return isObject(item) ? { id: text(item.id), webhook_url: text(item.webhook_url), secret: text(item.secret), enabled_events: Array.isArray(item.enabled_events) ? item.enabled_events.map(text) : [] } : undefined;
  }

  /** `secret` kept as `hook`'s, unless it already is. */
  private async keep(hook: string, secret: string): Promise<void> {
    if (secret && this.deps.sealed.get(hook, COMPOSIO_SECRET) !== secret) await this.deps.sealed.set(hook, COMPOSIO_SECRET, secret, "utf8");
  }

  /** The project's subscription for a trigger: made here if there is none (undone with `undo`), reused if it is this
   *  server's, moved here only when `move`. Answers its hook. */
  private async subscribe(ask: Ask, move: boolean, undo: (() => Promise<void>)[]): Promise<string> {
    let sub = await this.subscriptionOf(ask);
    if (!sub) {
      const hook = newHook();
      const made = await ask("making the project's webhook subscription", "POST", "/api/v3/webhook_subscriptions", { webhook_url: this.addressOf(hook), enabled_events: EVENTS, version: VERSION }).catch(async (error: unknown) => {
        // Another create made it meanwhile (Composio's 409): that one is read below.
        if (!(error instanceof ApiError) || error.code !== "input_invalid" || !(await this.subscriptionOf(ask))) throw error;
        return undefined;
      });
      if (made) {
        // Its undo first, so one whose secret can't be kept here is deleted at Composio all the same; not while a
        // trigger uses its hook, read then.
        undo.push(async () => {
          if ((await this.deps.holders()).some((h) => h.source.hook === hook)) return;
          await ask("deleting the webhook subscription it made", "DELETE", `/api/v3/webhook_subscriptions/${enc(text(made.id))}`);
          await this.deps.sealed.remove(hook);
        });
        await this.keep(hook, text(made.secret));
        this.deps.say({ condition: "composio_subscription_made", hook });
        return hook;
      }
      sub = (await this.subscriptionOf(ask))!;
    }
    const ours = this.oursOf(sub.webhook_url);
    if (ours) {
      await this.keep(ours, sub.secret);
      return ours;
    }
    if (!move) throw new ApiError("composio_subscription_elsewhere", `This Composio project's webhook subscription sends its events to ${sub.webhook_url}, not to this server. Move it here (every event of the project then comes here), or use a Composio server with another project's key.`, { details: { webhook_url: sub.webhook_url } });
    // Moved under the hook its address already names when that hook is kept here (this server's, at an older public
    // address), so the triggers on it go on; else a new one.
    const was = this.hookIn(sub.webhook_url);
    const known = was !== undefined && this.deps.sealed.get(was, COMPOSIO_SECRET) !== undefined;
    const hook = known ? was : newHook();
    const events = [...new Set([...sub.enabled_events, ...EVENTS])];
    const moved = await ask("moving the project's webhook subscription here", "PATCH", `/api/v3/webhook_subscriptions/${enc(sub.id)}`, { webhook_url: this.addressOf(hook), enabled_events: events });
    const previous = sub;
    undo.push(async () => {
      await ask("moving the webhook subscription back", "PATCH", `/api/v3/webhook_subscriptions/${enc(previous.id)}`, { webhook_url: previous.webhook_url, enabled_events: previous.enabled_events });
      if (!known) await this.deps.sealed.remove(hook);
    });
    await this.keep(hook, text(moved.secret) || sub.secret);
    this.deps.say({ condition: "composio_subscription_moved", from: sub.webhook_url, hook });
    return hook;
  }

  /** The id of the one ACTIVE account the server's user has for its toolkit; none: refused, with the link to connect it;
   *  several: refused, naming each with when it was connected, so the owner disconnects the ones it shouldn't run as. */
  private async accountOf(ask: Ask, credential: ComposioCredential, server: string): Promise<string> {
    const accounts = await ask("checking the connected account", "GET", `/api/v3/connected_accounts?user_ids=${enc(credential.user)}&toolkit_slugs=${enc(credential.toolkit)}&statuses=ACTIVE`);
    const active = (Array.isArray(accounts.items) ? accounts.items : []).filter((a): a is Json => isObject(a) && a.status === "ACTIVE" && !!text(a.id));
    if (active.length === 1) return text(active[0]!.id);
    // Several: never one picked, which would run the trigger as an account the owner didn't choose, unseen.
    if (active.length > 1) {
      const listed = active.map((a) => ({ id: text(a.id), created_at: text(a.created_at) })).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      throw new ApiError("composio_account_ambiguous", `${server}'s Composio user ${credential.user} has ${listed.length} connected ${credential.toolkit} accounts: ${listed.map((a) => `${a.id} (connected ${a.created_at || "at an unknown time"})`).join(", ")}. A trigger runs as one account: disconnect the ones it shouldn't run as in Composio, then make the trigger again.`, { details: { server, user_id: credential.user, accounts: listed } });
    }
    // The link is under the toolkit's Composio-managed auth config, the one the server's save made or found.
    const configs = await ask("finding the toolkit's auth config", "GET", `/api/v3/auth_configs?toolkit_slug=${enc(credential.toolkit)}`);
    const managed = (Array.isArray(configs.items) ? configs.items : []).find((c) => isObject(c) && c.is_composio_managed === true && c.status !== "DISABLED" && text(c.id));
    const link = isObject(managed) ? text((await ask("making the connect link", "POST", "/api/v3/connected_accounts/link", { auth_config_id: text(managed.id), user_id: credential.user })).redirect_url) : "";
    throw new ApiError("composio_not_connected", `${server}'s Composio user ${credential.user} has no connected ${credential.toolkit} account: connect it${link ? ` at ${link}` : " in Composio"}, then make the trigger again.`, { details: { server, user_id: credential.user, ...(link ? { connect_url: link } : {}) } });
  }
}
