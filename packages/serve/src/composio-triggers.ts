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
// - One project's steps run one at a time (serial): a create's setup, its save here and its undo, a pause, a delete, a
//   rotate, the subscription's delete and the saved server's delete; a template update's removal (removedThere) deletes
//   its trigger here in the same step, once Composio is done. Each reads the triggers holding what it would undo,
//   turn off or delete as they are then, so it never removes what another holds, a pause or resume sets the instance as
//   its triggers now stand, and a create re-reads its saved server before it saves, so no trigger outlives its server.
// - A config field named like a credential (trigger-composio.ts sealedConfigFields) is sealed at the create, each under
//   its own scope of the same sealed settings (configScope), and the trigger keeps SEALED_MASK in its place, the field
//   named in `sealed_config`: Composio's upsert alone gets the value. A PATCH that leaves it out or sends the mask keeps
//   it; any other value is a change to the config, refused. The delete removes it. A trigger kept before this rule with
//   its key in the clear is answered masked all the same (shownSource), and sealed at the next start (sealKept).
// No public address (AGENTRUN_PUBLIC_URL): Composio can't reach this server, so making one is refused before Composio is
// asked anything.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError, invalid } from "./errors.js";
import { accountsUnder, type Ask, asking, type ComposioControl, managedConfig } from "./composio-preset.js";
import type { Source } from "./trigger-adapter.js";
import { COMPOSIO_HOOK, COMPOSIO_SECRET, CONFIG_SECRET, CONFIG_UNLISTED, configScope, configSecrets, MOVE_FIELD, SEALED_FIELD, SEALED_MASK, sealableValue, sealedConfigFields, sealedKept, sealedSchemaFields, shownSource } from "./trigger-composio.js";
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

/** A saved Composio server's key, the Composio user its address names, its toolkit, and the auth config its save stands
 *  on (the managed one found or made, or the one auth_config_id named; none for a server saved before that was recorded,
 *  whose link is then under managedConfig's, or of a toolkit with no sign-in). */
export type ComposioCredential = { key: string; user: string; toolkit: string; auth_config?: string };
/** What an instance comes to once a trigger no longer holds it (leftWith). */
type Left = "delete" | "off" | "keep";
/** A trigger of kind composio, as the engine keeps it. */
type Holder = { id: string; name: string; enabled: boolean; source: Source; updatedAt?: number };
type Sealed = { get(scope: string, field: string): string | undefined; set(scope: string, field: string, value: string, as?: "utf8"): Promise<void>; remove(scope: string): Promise<void> };
type Subscription = { id: string; webhook_url: string; secret: string; enabled_events: string[] };

export type ComposioTriggerDeps = {
  control: ComposioControl;
  /** This server's public address, no trailing slash: the subscription's address starts with it. */
  publicUrl?: string;
  /** The composio source's sealed settings: each hook's subscription secret. */
  sealed: Sealed;
  /** Saved server `name`'s key, user, toolkit and auth config; refused (thrown) when it is no Composio server: by the source's field at
   *  a trigger's create (`field`), as a 404 on its own routes (`route`). */
  credential(name: string, refusal: "field" | "route"): Promise<ComposioCredential>;
  /** Every trigger of kind composio, on or off. */
  holders(): Promise<Holder[]>;
  signal?: AbortSignal;
  say(fields: Record<string, string>): void;
};

/** An event of a toolkit as the console's form reads it: `sealed`, the fields of its config a save seals. */
export type ComposioEvent = { slug: string; name: string; description: string; instructions?: string; config: Json; polled: boolean; sealed: string[] };

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const enc = encodeURIComponent;
const newHook = () => `cph_${randomBytes(12).toString("hex")}`;
const instanceOf = (source: Source) => String(source.instance_id);
/** The config fields `source` keeps sealed (its sealed_config). */
const sealedOf = (source: Source): string[] => (Array.isArray(source[SEALED_FIELD]) ? (source[SEALED_FIELD] as unknown[]).filter((name): name is string => typeof name === "string") : []);
/** The settings field a sealed config value is kept under: one the list of the server's secrets can hold (8 bytes or
 *  more, no whitespace), else the unlisted one. */
const configFieldFor = (value: string) => (!/\s/.test(value) && Buffer.byteLength(value, "utf8") >= 8 ? CONFIG_SECRET : CONFIG_UNLISTED);

/** The keys of a sealed_config name's place in the config: a top-level name as it is, a JSON Pointer's unescaped. */
const placeOf = (name: string): string[] => (name.startsWith("/") ? name.slice(1).split("/").map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~")) : [name]);
/** The value at `path` in `config` where it is still kept in the clear (a trigger an earlier server saved), as text. */
const clearAt = (config: unknown, path: readonly string[]): string | undefined => {
  let node: unknown = config;
  for (const key of path) node = isObject(node) ? node[key] : Array.isArray(node) ? node[Number(key)] : undefined;
  return (typeof node === "string" || typeof node === "number") && node !== SEALED_MASK ? String(node) : undefined;
};
/** Whether two secrets are equal, in time that does not depend on where they differ: each digested first, so two of
 *  different lengths compare as two equal-length buffers. */
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(createHash("sha256").update(a, "utf8").digest(), createHash("sha256").update(b, "utf8").digest());

/** `said` with each of `values` (sealed config values) put as the mask. */
/** An error's words for a log line: none with sealed config values (`values`) in play, as a quote of one may be in a form
 *  no match finds (JSON-escaped, encoded); its code alone then. */
const told = (error: unknown, values: readonly string[]): string =>
  values.some(Boolean) ? `${error instanceof ApiError ? error.code : "error"} (its words are withheld: the config holds a sealed value)` : String((error as Error)?.message ?? error);

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

/** A Composio trigger's refusal on a server with no public URL: made by make, and read by an apply's plan, which asks
 *  Composio nothing. */
export const composioNoPublicUrl = (): ApiError => new ApiError("composio_no_public_url", "Composio can't reach this server: set its public URL first (AGENTRUN_PUBLIC_URL, the https address Composio sends events to), then make the trigger.");

export class ComposioTriggers implements TriggerUpstream {
  /** Each project's last step queued (serial), by a digest of its key. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: ComposioTriggerDeps) {}

  // ---- the trigger engine's (TriggerUpstream) ----------------------------------------------------------------------------

  async make<T>(source: Source, id: string, enabled: boolean, keep: (source: Source) => Promise<T>): Promise<T> {
    if (!this.deps.publicUrl) throw composioNoPublicUrl();
    for (const field of ["instance_id", "hook", SEALED_FIELD]) if (source[field] !== undefined) throw invalid([{ field: `source.${field}`, reason: "not_allowed", message: `${field} is set by this server when it makes the trigger on Composio: leave it out.` }]);
    const config = source.config as Json;
    // A credential below the config's top level is refused: a create seals one as a top-level field alone (and Composio's
    // trigger configs are flat), so none is kept here in the clear.
    const deeper = configSecrets(config).filter((secret) => secret.path.length > 1);
    if (deeper.length) throw invalid(deeper.map((secret) => ({ field: `source.config.${secret.path.join(".")}`, reason: "not_allowed", message: `${secret.name} is a credential below the config's top level: this server seals a credential only as a top-level field of the config, so it can't keep this one. Give it as a top-level field, or leave it out.` })));
    const named = sealedConfigFields(config);
    const refuseMasked = (sealing: readonly string[]) => {
      const masked = sealing.filter((name) => config[name] === SEALED_MASK);
      if (masked.length) throw invalid(masked.map((name) => ({ field: `source.config.${name}`, reason: "invalid", message: `${name} is a credential: give its value. "${SEALED_MASK}" is what an answer shows in its place.` })));
    };
    refuseMasked(named);
    const server = String(source.server);
    const credential = await this.deps.credential(server, "field");
    const event = String(source.event);
    const missing = `Composio has no event ${event} for ${credential.toolkit}: pick one from the server's events.`;
    // Made, saved here, and undone when not saved, alone among the project's steps.
    return this.serial(credential.key, async () => {
      // The event's schema first, a read: a field it marks as a credential (format: password, writeOnly) is sealed too,
      // whatever its name (sealedSchemaFields).
      const type = await this.ask(credential, "nothing was saved", named.map((name) => String(config[name])))(`reading ${event}'s config on Composio`, "GET", `/api/v3/triggers_types/${enc(event)}`, undefined, missing).catch((error: unknown) => {
        throw onField(error, "source.event");
      });
      const sealing = [...new Set([...named, ...sealedSchemaFields(type.config).filter((name) => sealableValue(config[name]))])];
      refuseMasked(sealing);
      const values = sealing.map((name) => String(config[name]));
      const ask = this.ask(credential, "nothing was saved", values);
      const undo: (() => Promise<void>)[] = [];
      try {
        // The account first: a read, so a server not connected yet leaves nothing made on Composio.
        const account = await this.accountOf(ask, credential, server);
        const hook = await this.subscribe(ask, source[MOVE_FIELD] === true, undo);
        const made = await ask(`turning on ${event} on Composio`, "POST", `/api/v3/trigger_instances/${enc(event)}/upsert`, { connected_account_id: account, user_id: credential.user, trigger_config: source.config }, missing).catch((error: unknown) => {
          throw onField(onField(error, "source.config"), "source.event");
        });
        const instance = text(made.trigger_id);
        if (!instance) throw new ApiError("upstream_failed", "Composio made no trigger instance: nothing was saved.");
        // Composio's one instance per server, event and config: the triggers already holding it keep it. Not kept, this
        // trigger leaves it as the triggers holding it then would (the upsert turned it on): deleted, off, or as it is.
        undo.push(async () => this.leave(ask, instance, await this.leftWith(instance, id)));
        if (!enabled && (await this.leftWith(instance, id)) !== "keep") await ask("turning the trigger instance off", "PATCH", `/api/v3/trigger_instances/manage/${enc(instance)}`, { status: "disable" });
        // The saved server is still there, under the key and on the auth config this was made with: one deleted (or saved
        // again with another key, or onto another config, whose accounts the instance's isn't) meanwhile is refused here,
        // and what was made is undone, so no trigger names a server that is gone or an account it doesn't serve.
        const now = await this.deps.credential(server, "field");
        if (now.key !== credential.key) throw invalid([{ field: "source.server", reason: "invalid", message: `${server} was saved again with another Composio key while this trigger was being made: nothing was saved, make it again.` }]);
        if (now.auth_config !== credential.auth_config) throw invalid([{ field: "source.server", reason: "invalid", message: `${server} was saved again on another auth config while this trigger was being made: nothing was saved, make it again.` }]);
        // Each credential of its config sealed, the trigger keeping the mask in its place: Composio's upsert above was the
        // one place it went.
        undo.push(async () => {
          for (const name of sealing) await this.deps.sealed.remove(configScope(id, name));
        });
        // A number is sealed as its decimal text; Composio got it, as a number, in the upsert above.
        for (const name of sealing) await this.deps.sealed.set(configScope(id, name), configFieldFor(String(config[name])), String(config[name]));
        const { [MOVE_FIELD]: _moved, ...kept } = source;
        const shown = sealing.length ? { config: { ...config, ...Object.fromEntries(sealing.map((name) => [name, SEALED_MASK])) }, [SEALED_FIELD]: sealing } : {};
        return await keep({ ...kept, ...shown, instance_id: instance, hook });
      } catch (error) {
        for (const step of undo.splice(0).reverse()) await step().catch((undone: unknown) => this.deps.say({ condition: "composio_undo_failed", trigger: id, error: told(undone, values) }));
        throw error;
      }
    });
  }

  /** A source sent whole again for trigger `id` (`was`), as an apply with agent_id sends its package's, its credentials in
   *  the clear: each sealed field whose value it sends is the value sealed (compared in constant time) is left out, so the
   *  PATCH keeps it (patched); then patched's own check, so another value, or any other change to the config, is refused
   *  here, before the caller writes anything, in patched's words (none holds a value). The answer is the source to PATCH
   *  the trigger with: no sealed value is in it. */
  resent(was: Source, id: string, given: Source): Source {
    const config = isObject(given.config) ? (structuredClone(given.config) as Json) : given.config;
    if (isObject(config)) {
      for (const name of sealedOf(shownSource(was))) {
        const path = placeOf(name);
        let node: unknown = config;
        for (const key of path.slice(0, -1)) node = isObject(node) ? node[key] : undefined;
        const last = path.at(-1)!;
        if (!isObject(node)) continue;
        const sent = node[last];
        if (!(typeof sent === "string" || typeof sent === "number") || sent === SEALED_MASK) continue;
        const kept = this.deps.sealed.get(configScope(id, name), CONFIG_SECRET) ?? this.deps.sealed.get(configScope(id, name), CONFIG_UNLISTED) ?? clearAt(was.config, path);
        if (kept !== undefined && sameSecret(String(sent), kept)) delete node[last];
      }
    }
    const source: Source = { ...given, config };
    this.patched(was, source);
    return source;
  }

  patched(was: Source, given: Source): Source {
    const fixed = "A Composio trigger's server, event and config made its instance on Composio, so they stay: to change one (a sealed key too), delete the trigger and make a new one.";
    for (const field of ["server", "event", "instance_id", "hook"]) if (given[field] !== undefined && given[field] !== was[field]) throw invalid([{ field: `source.${field}`, reason: "not_allowed", message: fixed }]);
    // A sealed field left out, or sent as the mask an answer shows, keeps its value; any other value is a change. Read
    // against the source as answered (shownSource), so one still kept in the clear compares as the answer showed it.
    const shown = shownSource(was);
    const sealed = sealedOf(shown);
    const sent = given.config;
    // At its own place: a top-level name, or a nested one's JSON Pointer (a trigger an earlier server kept).
    const config = isObject(sent) && sealed.length ? sealedKept(sent, shown.config, sealed) : sent;
    if (!same(config, shown.config)) throw invalid([{ field: "source.config", reason: "not_allowed", message: fixed }]);
    if (given[MOVE_FIELD] !== undefined) throw invalid([{ field: `source.${MOVE_FIELD}`, reason: "not_allowed", message: `${MOVE_FIELD} is a create's alone.` }]);
    const { [SEALED_FIELD]: _given, ...rest } = given;
    const kept = sealedOf(was);
    return { ...rest, config: was.config, ...(kept.length ? { [SEALED_FIELD]: kept } : {}), instance_id: was.instance_id, hook: was.hook };
  }

  async turned(source: Source, id: string, on: boolean): Promise<Json | undefined> {
    const instance = instanceOf(source);
    try {
      const credential = await this.deps.credential(String(source.server), "field");
      await this.serial(credential.key, async () => {
        // Set from the triggers holding it as they stand once this step has the turn, not from what was asked (a pause
        // that waited behind a later resume): on while one of them is on, off once every one is. None left: the delete
        // that took it has its own step.
        const holding = (await this.deps.holders()).filter((h) => h.source.instance_id === instance);
        if (!holding.length) return;
        on = holding.some((h) => h.enabled);
        await this.ask(credential, "nothing was changed", this.sealedValues(holding))(`turning the trigger instance ${on ? "on" : "off"}`, "PATCH", `/api/v3/trigger_instances/manage/${enc(instance)}`, { status: on ? "enable" : "disable" });
      });
      return undefined;
    } catch (error) {
      this.deps.say({ condition: "composio_instance_not_turned", trigger: id, instance, on: String(on), error: String((error as Error)?.message ?? error) });
      return { composio: { done: false, note: `Composio didn't turn the trigger instance ${instance} ${on ? "on" : "off"}: turn it ${on ? "on" : "off"} there yourself: ${DASHBOARD}` } };
    }
  }

  async removed(source: Source, id: string): Promise<Json | undefined> {
    // Its sealed config goes with it, whatever Composio says below; read first, so Composio's words about its instance are
    // withheld (asking).
    const values = this.sealedValues([{ id, source }]);
    await this.forgotten(source, id);
    return this.leftThere(source, id, values);
  }

  async removedThere(source: Source, id: string, here: () => Promise<void>): Promise<Json | undefined> {
    return this.leftThere(source, id, this.sealedValues([{ id, source }]), here);
  }

  async forgotten(source: Source, id: string): Promise<void> {
    for (const name of sealedOf(source)) await this.deps.sealed.remove(configScope(id, name)).catch((error: unknown) => this.deps.say({ condition: "composio_sealed_config_not_removed", trigger: id, field: name, error: String((error as Error)?.message ?? error) }));
  }

  /** The trigger `id`'s instance on Composio deleted, or turned off while other triggers hold it (none of them on), or
   *  kept (one of them on): undefined when that is done, else what is left there, said. `values`: its sealed config's,
   *  withheld from Composio's words. `here`, once that is done, in the same step of the project's: the trigger's delete
   *  here, so the next removal of a trigger sharing the instance reads the holders without it (two removals at once
   *  never each keep the instance for the other); its refusal is thrown, never said as Composio's. */
  private async leftThere(source: Source, id: string, values: readonly string[], here?: () => Promise<void>): Promise<Json | undefined> {
    const instance = instanceOf(source);
    let left = "delete" as Left;
    let failed = undefined as { error: unknown } | undefined;
    // Kept while another trigger holds it, and off once none of those is on, as a pause leaves it.
    const credential = await this.deps.credential(String(source.server), "field").catch((error: unknown) => void (failed = { error }));
    if (credential) {
      await this.serial(credential.key, async () => {
        try {
          await this.leave(this.ask(credential, "nothing was changed", values), instance, (left = await this.leftWith(instance, id)));
        } catch (error) {
          failed = { error };
          return;
        }
        await here?.();
      });
    }
    if (failed === undefined) return undefined;
    const said = String((failed.error as Error)?.message ?? failed.error);
    if (left === "off") {
      this.deps.say({ condition: "composio_instance_not_turned", trigger: id, instance, on: "false", error: said });
      return { composio: { done: false, note: `Composio didn't turn the trigger instance ${instance} off, and no trigger left that holds it is on: turn it off there yourself: ${DASHBOARD}` } };
    }
    this.deps.say({ condition: "composio_instance_not_removed", trigger: id, instance, error: said });
    return { composio: { done: false, note: `Composio didn't delete the trigger instance ${instance}: remove it there yourself: ${DASHBOARD}` } };
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
      events.push({ slug: text(item.slug), name: text(item.name) || text(item.slug), description: text(item.description), ...(text(item.instructions) ? { instructions: text(item.instructions) } : {}), config, polled: item.type === "poll", sealed: sealedSchemaFields(config) });
    }
    return { server: name, toolkit: credential.toolkit, events };
  }

  /** GET /settings/mcp-servers/{name}/composio/triggers: its triggers, each with its instance's state on Composio, and
   *  whether the project's subscription is this server's. What Composio did not answer is `unknown`, and said. */
  async triggersOf(name: string): Promise<{ triggers: Json[]; subscription: Json | null; composio_error?: string }> {
    const credential = await this.deps.credential(name, "route");
    const mine = (await this.deps.holders()).filter((h) => h.source.server === name);
    const ask = this.ask(credential, "nothing was changed", this.sealedValues(mine));
    // What Composio answered, and whether it answered for every instance: one it didn't answer for is unknown, not missing.
    const states = new Map<string, "on" | "off">();
    let read = false;
    let subscription: Json | null = null;
    let failed: string | undefined;
    try {
      const sub = await this.subscriptionOf(ask);
      subscription = sub ? { ours: this.oursOf(sub.webhook_url) !== undefined, webhook_url: sub.webhook_url } : null;
      const ids = [...new Set(mine.map((h) => instanceOf(h.source)))];
      // A page's worth of ids asked at a time, each answer read to its last page.
      for (let i = 0; i < ids.length; i += PAGE) {
        const listed = await this.every(ask, "reading the trigger instances", `/api/v3/trigger_instances/active?trigger_ids=${ids.slice(i, i + PAGE).map(enc).join(",")}&show_disabled=true`);
        for (const item of listed) if (isObject(item) && text(item.id)) states.set(text(item.id), item.disabled_at ? "off" : "on");
      }
      read = true;
    } catch (error) {
      failed = String((error as Error)?.message ?? error);
    }
    const triggers = mine.map((h) => ({ id: h.id, name: h.name, enabled: h.enabled, event: h.source.event, instance_id: h.source.instance_id, on_composio: states.get(instanceOf(h.source)) ?? (read ? "missing" : "unknown") }));
    return { triggers, subscription, ...(failed ? { composio_error: failed } : {}) };
  }

  /** POST /settings/mcp-servers/{name}/composio/rotate-secret: the subscription's new secret, kept; none answered. */
  async rotate(name: string): Promise<{ rotated: true }> {
    const credential = await this.deps.credential(name, "route");
    // In the project's turn: a create's older read of the subscription can't write the old secret back over the new one.
    return this.serial(credential.key, async () => {
      const ask = this.ask(credential, "the old secret still signs");
      const sub = await this.subscriptionOf(ask);
      const hook = this.need(sub);
      const rotated = await ask("rotating the webhook subscription's secret", "POST", `/api/v3/webhook_subscriptions/${enc(sub!.id)}/rotate_secret`);
      const secret = text(rotated.secret);
      if (!secret) throw new ApiError("upstream_failed", "Composio gave no new secret: the old one still signs.");
      await this.keep(hook, secret);
      this.deps.say({ condition: "composio_secret_rotated", server: name, hook });
      return { rotated: true as const };
    });
  }

  /** DELETE /settings/mcp-servers/{name}/composio/subscription: the project's subscription deleted on Composio, and its
   *  secret here; refused while a trigger uses it. */
  async forget(name: string): Promise<{ deleted: true }> {
    const credential = await this.deps.credential(name, "route");
    // In the project's turn: a create still making its instance holds the subscription by the time this reads who uses it.
    return this.serial(credential.key, async () => {
      const ask = this.ask(credential);
      const sub = await this.subscriptionOf(ask);
      const hook = this.need(sub);
      const using = (await this.deps.holders()).filter((h) => h.source.hook === hook);
      if (using.length) throw new ApiError("composio_in_use", `The project's webhook subscription is used by ${using.map((h) => h.name).join(", ")}: delete ${using.length > 1 ? "them" : "it"} first.`, { details: { triggers: using.map((h) => ({ id: h.id, name: h.name })) } });
      await ask("deleting the webhook subscription", "DELETE", `/api/v3/webhook_subscriptions/${enc(sub!.id)}`);
      await this.deps.sealed.remove(hook);
      return { deleted: true as const };
    });
  }

  /** Saved server `name` deleted by `remove`, refused (inUse) while Composio triggers use it. A Composio server's check and
   *  delete take its project's turn, so a create still making its first trigger is saved, and counted, before the check;
   *  any other server (no Composio key) is deleted with no turn and nothing asked of Composio. */
  async deleting<T>(name: string, remove: () => Promise<T>): Promise<T> {
    return this.inTurnOf(name, async () => {
      await this.inUse(name);
      return remove();
    });
  }

  /** `step` in the turn of saved server `name`'s Composio project, when it is a Composio server (its key opens): a create
   *  still making its first trigger on it is saved, and counted, before `step` reads who uses it. Any other server's runs
   *  at once. A save that moves the server off what its triggers stand on checks inUse in it (server.ts saveMcpServer). */
  async inTurnOf<T>(name: string, step: () => Promise<T>): Promise<T> {
    const credential = await this.deps.credential(name, "route").catch(() => undefined);
    return credential ? this.serial(credential.key, step) : step();
  }

  /** The triggers that use saved server `name`: a server that has any is not deleted, nor saved off what they stand on
   *  (`then`: what to do once they are gone), refused, naming them. */
  async inUse(name: string, then = "then the server"): Promise<void> {
    const using = (await this.deps.holders()).filter((h) => h.source.server === name);
    if (using.length) throw new ApiError("composio_in_use", `${name} has Composio triggers: ${using.map((h) => h.name).join(", ")}. Delete ${using.length > 1 ? "them" : "it"} first, ${then}.`, { details: { triggers: using.map((h) => ({ id: h.id, name: h.name })) } });
  }

  /** At the server's start: each composio trigger kept with a credential of its config in the clear (made before the
   *  config was sealed) sealed now, its source rewritten (`rewrite`) as an answer shows it (shownSource: the mask in its
   *  place), and said with the trigger's id and the fields' names alone. Composio's instance is left as it is: it already
   *  holds the value. One that can't be sealed is said, still answered masked, and left for the next start. A trigger
   *  with nothing in the clear is passed over, so a second start does nothing. */
  async sealKept(rewrite: (id: string, source: Source) => Promise<void>): Promise<number> {
    let done = 0;
    for (const holder of await this.deps.holders()) {
      // At any depth: an earlier server took a config with one below its top level, each sealed by its JSON Pointer.
      const clear = configSecrets(holder.source.config);
      if (!clear.length) continue;
      const names = clear.map((secret) => secret.name).join(",");
      try {
        for (const secret of clear) await this.deps.sealed.set(configScope(holder.id, secret.name), configFieldFor(String(secret.value)), String(secret.value));
        await rewrite(holder.id, shownSource(holder.source));
        this.deps.say({ condition: "composio_config_sealed", trigger: holder.id, fields: names });
        done++;
      } catch (error) {
        this.deps.say({ condition: "composio_config_not_sealed", trigger: holder.id, fields: names, error: told(error, clear.map((secret) => String(secret.value))) });
      }
    }
    return done;
  }

  /** After the server's start, never holding it up: each composio trigger an earlier server kept with a value in the clear
   *  in a field only its event's schema marks (format: password, writeOnly: sealedSchemaFields; the name rule is
   *  sealKept's) sealed, as sealKept seals one. Each event's schema is read once from Composio with its server's key, its
   *  words withheld when the server's triggers hold sealed values. When a read fails (Composio down), that is said once,
   *  by a code, and those triggers are left for the next start. The rewrites run inside `around` (the store's
   *  secureRewrite), once, and only when there is one to make. */
  async sealMarked(rewrite: (id: string, source: Source, updatedAt: number | undefined, read: Source) => Promise<boolean>, around: (work: () => Promise<number>) => Promise<unknown>): Promise<void> {
    const eventOf = (holder: Holder) => `${String(holder.source.server)}\n${String(holder.source.event)}`;
    // A top-level value in the clear its sealed_config doesn't name: one the schema may mark.
    const plain = (source: Source): string[] => {
      const sealed = new Set(sealedOf(source));
      return isObject(source.config) ? Object.entries(source.config).filter(([name, value]) => !sealed.has(name) && value !== SEALED_MASK && sealableValue(value)).map(([name]) => name) : [];
    };
    const holders = (await this.deps.holders()).filter((holder) => plain(holder.source).length);
    const marked = new Map<string, string[]>();
    let unread = 0;
    let failed: unknown;
    for (const event of new Set(holders.map(eventOf))) {
      if (this.deps.signal?.aborted) return;
      const [server, slug] = event.split("\n") as [string, string];
      try {
        const credential = await this.deps.credential(server, "field");
        const type = await this.ask(credential, "nothing was changed", this.sealedValues(holders.filter((holder) => eventOf(holder) === event)))(`reading ${slug}'s config on Composio`, "GET", `/api/v3/triggers_types/${enc(slug)}`);
        marked.set(event, sealedSchemaFields(type.config));
      } catch (error) {
        unread++;
        failed ??= error;
      }
    }
    if (unread && !this.deps.signal?.aborted) this.deps.say({ condition: "composio_config_schemas_unread", events: String(unread), error: failed instanceof ApiError ? failed.code : "error" });
    const due = (holder: Holder) => plain(holder.source).filter((name) => marked.get(eventOf(holder))?.includes(name));
    if (this.deps.signal?.aborted || !holders.some((holder) => due(holder).length)) return;
    await around(async () => {
      let done = 0;
      // Read again: a request since may have changed or deleted one.
      for (const holder of await this.deps.holders()) {
        const fields = due(holder);
        if (!fields.length) continue;
        const config = holder.source.config as Json;
        const values = fields.map((name) => String(config[name]));
        const unseal = async () => {
          for (const name of fields) await this.deps.sealed.remove(configScope(holder.id, name)).catch(() => undefined);
        };
        let written: boolean;
        try {
          for (const [i, name] of fields.entries()) await this.deps.sealed.set(configScope(holder.id, name), configFieldFor(values[i]!), values[i]!);
          // These fields alone masked: any other value is as the row keeps it (sealKept's). Written only while the row is
          // the one read here (its updatedAt and its source: one millisecond's writes share an updatedAt): a PATCH since (an
          // accept) is not undone, a delete since leaves no sealed row.
          written = await rewrite(holder.id, { ...holder.source, config: { ...config, ...Object.fromEntries(fields.map((name) => [name, SEALED_MASK])) }, [SEALED_FIELD]: [...new Set([...sealedOf(holder.source), ...fields])] }, holder.updatedAt, holder.source);
        } catch (error) {
          await unseal();
          this.deps.say({ condition: "composio_config_not_sealed", trigger: holder.id, fields: fields.join(","), error: told(error, values) });
          continue;
        }
        if (!written) {
          await unseal();
          this.deps.say({ condition: "composio_config_not_sealed", trigger: holder.id, fields: fields.join(","), error: "changed_meanwhile" });
          continue;
        }
        // Written: the row is masked, so its sealed values are now the one copy and nothing after this undoes them.
        this.deps.say({ condition: "composio_config_sealed", trigger: holder.id, fields: fields.join(",") });
        done++;
      }
      return done;
    });
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

  /** The sealed config values `holders` keep here: what Composio may quote back about their instance. */
  private sealedValues(holders: readonly { id: string; source: Source }[]): string[] {
    return holders.flatMap((h) => sealedOf(h.source).map((name) => this.deps.sealed.get(configScope(h.id, name), CONFIG_SECRET) ?? this.deps.sealed.get(configScope(h.id, name), CONFIG_UNLISTED) ?? "")).filter(Boolean);
  }

  /** Composio asked with the server's key; a failure's words end with what it left (`outcome`), and pass on none of
   *  Composio's own with a value of `sealed` (a trigger's sealed config) in play. */
  private ask(credential: ComposioCredential, outcome = "nothing was changed", sealed: readonly string[] = []): Ask {
    return asking(this.deps.control, credential.key, this.deps.signal, outcome, sealed);
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
    // Only another server or a tool of the owner's can hold it (this server keeps no other way to make one): the words say
    // what a move stops.
    if (!move) throw new ApiError("composio_subscription_elsewhere", `Composio sends this project's events to ${sub.webhook_url} now. Moving them here stops them arriving there: anything listening at ${sub.webhook_url} (another AgentRun server, or a tool of yours) gets no more events.`, { details: { webhook_url: sub.webhook_url } });
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

  /** The id of the one ACTIVE account the server's user has for its toolkit (accountsUnder: never another user's), under
   *  the auth config the server's save stands on (as its MCP server serves only those; every config, for a server saved
   *  before that was recorded); none: refused, with the link to connect it under that config; several: refused, naming
   *  each with when it was connected, so the owner disconnects the ones it shouldn't run as. */
  private async accountOf(ask: Ask, credential: ComposioCredential, server: string): Promise<string> {
    const config = credential.auth_config;
    const active = (await accountsUnder(ask, { user: credential.user, toolkit: credential.toolkit, ...(config ? { auth_config: config } : {}) }, true)).filter((a) => !!text(a.id));
    if (active.length === 1) return text(active[0]!.id);
    const under = config ? ` under auth config ${config}` : "";
    // Several: never one picked, which would run the trigger as an account the owner didn't choose, unseen.
    if (active.length > 1) {
      const listed = active.map((a) => ({ id: text(a.id), created_at: text(a.created_at) })).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      throw new ApiError("composio_account_ambiguous", `${server}'s Composio user ${credential.user} has ${listed.length} connected ${credential.toolkit} accounts${under}: ${listed.map((a) => `${a.id} (connected ${a.created_at || "at an unknown time"})`).join(", ")}. A trigger runs as one account: disconnect the ones it shouldn't run as in Composio, then make the trigger again.`, { details: { server, user_id: credential.user, accounts: listed } });
    }
    // The link is under the server's auth config; for a server saved before that was recorded, under the one its save
    // found or made (managedConfig, the preset's own finder).
    const linkConfig = config || (await managedConfig(ask, credential.toolkit));
    const link = linkConfig ? text((await ask("making the connect link", "POST", "/api/v3/connected_accounts/link", { auth_config_id: linkConfig, user_id: credential.user })).redirect_url) : "";
    throw new ApiError("composio_not_connected", `${server}'s Composio user ${credential.user} has no connected ${credential.toolkit} account${under}: connect it${link ? ` at ${link}` : " in Composio"}, then make the trigger again.`, { details: { server, user_id: credential.user, ...(link ? { connect_url: link } : {}) } });
  }
}
