// A trigger source's sealed settings over the one store (store.triggerSettings), the store-backed replacement for the
// SealedSettings file class (sealed-settings.ts). Each (scope, field) is a sealed row, bound to its adapter, scope and
// field by the store's documented AAD trigger_settings|<adapter>|<scope>|<field>; the store holds base64 ciphertext and
// never opens it. With no seal key none is kept, never in the clear. The surface is SealedSettings', so the switch swaps
// `new SealedSettings(data, ...)` for `sealedSettingsOverStore(store, ...)` then awaits load() once: get()/values() are
// synchronous off a snapshot the server (the one writer) loads once and keeps in step with every write; set/mint/remove
// are durable before they resolve.
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, invalid } from "./errors.js";
import type { SettingsSpec } from "./sealed-settings.js";
import { keyBytes, MIN_KEY_BYTES, mintSecret, SECRET_PREFIX } from "./standard-webhooks.js";
import { SEAL_KEY_ENV } from "./tool-keys.js";
import type { TriggerSettings } from "./store/index.js";

export { SERVER_SCOPE, type SettingsSpec } from "./sealed-settings.js";

/** The store's documented AAD for a trigger setting (store schema `trigger_settings`): the composite row key is in the
 *  AAD, not store/seal.ts's single-row aadOf, which refuses a key holding the separator. */
const aad = (adapterId: string, scope: string, field: string) => `trigger_settings|${adapterId}|${scope}|${field}`;
/** A PEM private key, whole: its BEGIN line, its base64 lines, its END line. */
const PEM = /^-----BEGIN ((?:[A-Z]+ )*)PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1PRIVATE KEY-----\s*$/;

/** The store slice this layer reads and writes. */
type SealedSettingsStore = { readonly triggerSettings: Pick<TriggerSettings, "get" | "put" | "removeScope">; flush(): Promise<void> };

/** The scope a retired value of `scope` is kept under, its `n`th: one a scope's removal never matches. */
const retiredScope = (scope: string, n: number) => `retired:${scope}:${n}`;
/** The scope and number a retired row's scope names, or undefined for a live row's. */
const retiredScopeOf = (scope: string): { scope: string; n: number } | undefined => {
  const match = /^retired:(.+):(\d+)$/.exec(scope);
  return match ? { scope: match[1]!, n: Number(match[2]) } : undefined;
};

/** A (scope, field) pair as one key. */
const pair = (scope: string, field: string) => `${scope}\0${field}`;

class SealedSettingsOverStore {
  /** Opened, by scope and field: read once at load, then kept with every write. */
  private readonly opened: Record<string, Record<string, string>> = {};
  /** Values this store held and no longer does (replaced, or their scope removed): each kept sealed in a retired row too
   *  (retire), read back at load, so the server's redaction list holds them across a restart. Never a setting. */
  private readonly retired = new Set<string>();
  /** The PEM keys this store held and no longer does (each kept in a retired row too), listed by pemValues. */
  private readonly retiredPem: string[] = [];
  /** The last retired row's number for each scope, so the next one is new: `retired:<scope>:<n>`. */
  private readonly retiredCount = new Map<string, number>();
  /** The (scope, field) pairs kept here that did not open under this server's seal key at load: unset until set again. */
  private readonly unopened = new Set<string>();

  constructor(
    private readonly store: SealedSettingsStore,
    private readonly adapterId: string,
    private readonly spec: SettingsSpec,
    private readonly key: Buffer,
    private readonly say: (fields: Record<string, string>) => void,
  ) {}

  /** Reads this adapter's rows once into the snapshot, opening each; one that does not open under this server's seal key is
   *  said once and reads as unset (no row ever stops the start). Awaited once at start. */
  async load(): Promise<void> {
    const rows = await this.store.triggerSettings.get(this.adapterId);
    for (const row of rows) {
      const retiredOf = retiredScopeOf(row.scope);
      if (retiredOf) this.retiredCount.set(retiredOf.scope, Math.max(this.retiredCount.get(retiredOf.scope) ?? 0, retiredOf.n));
      try {
        const value = unseal(this.key, Buffer.from(row.sealed, "base64"), aad(this.adapterId, row.scope, row.field)).toString("utf8");
        // A retired row is read into the redaction list alone, never as a setting.
        if (retiredOf) this.remember(row.field, value);
        else (this.opened[row.scope] ??= {})[row.field] = value;
      } catch {
        if (retiredOf) {
          this.say({ condition: "trigger_setting_retired_unopened", adapter: this.adapterId, scope: row.scope, field: row.field, effect: `a retired value that does not open under ${SEAL_KEY_ENV} is not cut from what runs said` });
          continue;
        }
        this.unopened.add(pair(row.scope, row.field));
        this.say({ condition: "trigger_setting_unopened", adapter: this.adapterId, scope: row.scope, field: row.field, effect: `it does not open under ${SEAL_KEY_ENV}: unset until it is set again` });
      }
    }
  }

  /** A new secret for `scope`'s `field` (one the spec mints), written sealed before it is answered: its only showing. */
  async mint(scope: string, field: string): Promise<string> {
    if (!this.spec.fields[field]?.mint) throw new Error(`${this.adapterId}'s settings mint no ${field}`);
    const secret = mintSecret();
    await this.put(scope, field, secret);
    return secret;
  }

  /** A given value for `scope`'s `field` (a sender's signing secret, a bot's token), written sealed. One under its field's
   *  rules is refused, 422, before anything is written. */
  async set(scope: string, field: string, value: string): Promise<void> {
    const spec = this.spec.fields[field];
    if (!spec) throw new Error(`${this.adapterId}'s settings keep no ${field}`);
    if (spec.format === "pem" && !PEM.test(value)) throw invalid([{ field, reason: "invalid", message: `${field} is a PEM private key` }]);
    // A value the redaction list would pass over (whitespace, under 8 bytes) is never kept; a public one is no secret, and a
    // PEM key is listed by its lines (pemValues).
    if (!spec.public && spec.format !== "pem" && (/\s/.test(value) || Buffer.byteLength(value, "utf8") < 8)) throw invalid([{ field, reason: "invalid", message: `${field} is at least 8 bytes, with no whitespace` }]);
    if (spec.minBytes === MIN_KEY_BYTES && !value.startsWith(SECRET_PREFIX)) throw invalid([{ field, reason: "invalid", message: `${field} is a Standard Webhooks secret: whsec_ and its key in base64` }]);
    if (spec.minBytes !== undefined && keyBytes(value) < spec.minBytes) throw invalid([{ field, reason: "too_short", message: `${field} holds at least ${spec.minBytes} bytes` }]);
    await this.put(scope, field, value);
  }

  private async put(scope: string, field: string, value: string): Promise<void> {
    const was = this.opened[scope]?.[field];
    // The value it replaces is kept retired first: a write that fails after it leaves the old one cut, never lost.
    if (was !== undefined && was !== value) await this.retire(scope, field, was);
    await this.store.triggerSettings.put(this.row(scope, field, value));
    await this.store.flush();
    (this.opened[scope] ??= {})[field] = value;
    this.unopened.delete(pair(scope, field));
  }

  /** `value`, once `scope`'s `field`, kept sealed in a retired row of its own: scope `retired:<scope>:<n>` (a scope's
   *  removal, by (adapter, scope), never matches it), sealed under its own AAD, its updated_at the time it was retired.
   *  Read into the redaction list at every load; kept until no run that started before it is left (not pruned yet). */
  private async retire(scope: string, field: string, value: string): Promise<void> {
    // A public field is no secret: nothing to keep.
    if (this.spec.fields[field]?.format !== "pem" && this.secretsOf(field, value).length === 0) return;
    const n = (this.retiredCount.get(scope) ?? 0) + 1;
    await this.store.triggerSettings.put(this.row(retiredScope(scope, n), field, value));
    this.retiredCount.set(scope, n);
    this.remember(field, value);
  }

  /** `value` as `scope`'s `field` row, sealed under that row's own AAD. */
  private row(scope: string, field: string, value: string) {
    return { adapter: this.adapterId, scope, field, sealed: seal(this.key, Buffer.from(value, "utf8"), aad(this.adapterId, scope, field)).toString("base64") };
  }


  /** `scope`'s `field`, opened; undefined when it is not set, or does not open here. */
  get(scope: string, field: string): string | undefined {
    return this.opened[scope]?.[field];
  }

  /** Whether `scope`'s `field` is kept here but did not open under this server's seal key (sealed under another): unset
   *  here, and said once at load, until it is set again. */
  unopenedAt(scope: string, field: string): boolean {
    return this.unopened.has(pair(scope, field));
  }

  /** A scope's settings gone (a deleted trigger's). Durable before it resolves. */
  async remove(scope: string): Promise<void> {
    // A scope whose settings did not open here is removed all the same: its rows go with it.
    const unopened = [...this.unopened].filter((key) => key.startsWith(`${scope}\0`));
    if (!(scope in this.opened) && !unopened.length) return;
    for (const key of unopened) this.unopened.delete(key);
    // Each value it held is retired before its live rows go: a run that quoted it before the removal stays cut.
    for (const [field, value] of Object.entries(this.opened[scope] ?? {})) await this.retire(scope, field, value);
    await this.store.triggerSettings.removeScope(this.adapterId, scope);
    await this.store.flush();
    delete this.opened[scope];
  }

  /** Every value held open, and every one rotated or removed since this store opened, for the server's list of its own
   *  secrets: a run that echoes a secret after its rotation is cut all the same. */
  values(): string[] {
    return [...Object.values(this.opened).flatMap((fields) => Object.entries(fields).flatMap(([field, value]) => this.secretsOf(field, value))), ...this.retired];
  }

  /** What of `field`'s `value` is a secret to list with a floor: none for a public field or a PEM key (pemValues lists
   *  that), else the value. */
  private secretsOf(field: string, value: string): string[] {
    const spec = this.spec.fields[field];
    return spec?.public || spec?.format === "pem" ? [] : [value];
  }

  /** Every PEM key held open, or rotated or removed since this store opened: each whole and each of its base64 lines,
   *  the short last one too, listed with no floor (server-secrets.ts `whole`). */
  pemValues(): string[] {
    const pem = (field: string) => this.spec.fields[field]?.format === "pem";
    const forms = (value: string) => [value, ...value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("-----"))];
    return [...Object.values(this.opened).flatMap((fields) => Object.entries(fields).filter(([field]) => pem(field)).flatMap(([, value]) => forms(value))), ...this.retiredPem.flatMap(forms)];
  }

  /** `field`'s `value`, retired, in this process's redaction list: a PEM key by its lines (pemValues), else its secret. */
  private remember(field: string, value: string): void {
    if (this.spec.fields[field]?.format === "pem") this.retiredPem.push(value);
    else for (const secret of this.secretsOf(field, value)) this.retired.add(secret);
  }

}

export type { SealedSettingsOverStore };

/** The SealedSettings surface over the one store: the switch swaps `new SealedSettings(data, id, spec, key, say)` for this,
 *  then awaits load() once at start before the first get()/values(). */
export function sealedSettingsOverStore(store: SealedSettingsStore, adapterId: string, spec: SettingsSpec, key: Buffer, say: (fields: Record<string, string>) => void): SealedSettingsOverStore {
  return new SealedSettingsOverStore(store, adapterId, spec, key, say);
}
