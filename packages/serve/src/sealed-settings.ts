// A trigger source's sealed settings (trigger-adapter.ts `settings`): the trigger kernel's one store of them. One file
// per adapter, DIR/trigger-settings-<adapter>.json, holding each scope's fields (the server's, or one trigger's, by its
// id) sealed under the seal key (tool-keys.ts), each bound to its adapter, scope and field by its AAD. With no seal key
// none is kept, never in the clear. A file that does not read is never written over: nothing is made or removed until
// it is fixed. A value that does not open under this server's seal key is said once, kept sealed as it is, and reads as
// unset.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, invalid } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { keyBytes, MIN_KEY_BYTES, mintSecret, SECRET_PREFIX } from "./standard-webhooks.js";
import { SEAL_KEY_ENV } from "./tool-keys.js";
import { isObject } from "./validate.js";

/** What an adapter keeps sealed, and where: `server`, one set for the server; `trigger`, one set per trigger, by its id.
 *  A field with `mint` is a Standard Webhooks secret this server makes (standard-webhooks.ts), shown once; any other is
 *  given (set). `minBytes`: the fewest bytes its value may hold (standard-webhooks.ts keyBytes), MIN_KEY_BYTES for a key
 *  a request is verified with. `public`: a value that is no secret (who a Slack app is: its workspace's and its bot's
 *  ids), kept beside the secrets, sealed as they are, shown by GET /v2/settings/sources/{source} and never cut from what
 *  is shown (values); `given`, one of those a PUT of the settings may give (the rest its source's check fills).
 *  `managed`: settings a flow of their own writes, named here, which PUT and DELETE /v2/settings/sources/{source} refuse
 *  (source-settings.ts). */
export type SettingsField = { mint?: true; minBytes?: number; public?: true; given?: true };
export type SettingsSpec = { scope: "server" | "trigger"; fields: Record<string, SettingsField>; managed?: string };
/** The scope of a server-scoped adapter's settings. */
export const SERVER_SCOPE = "server";

export const settingsFile = (adapterId: string) => `trigger-settings-${adapterId}.json`;
const aad = (adapterId: string, scope: string, field: string) => `trigger-settings|${adapterId}|${scope}|${field}`;
type Sealed = Record<string, Record<string, string>>;

/** The sealed values `file` keeps, by scope and field: none when there is no file, and why not when it does not read. */
function sealedIn(file: string): { sealed: Sealed } | { unreadable: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { sealed: {} } : { unreadable: (error as Error).message };
  }
  try {
    const doc = JSON.parse(text) as unknown;
    const whole = isObject(doc) && doc.v === 1 && isObject(doc.values) && Object.values(doc.values).every((fields) => isObject(fields) && Object.values(fields).every((v) => typeof v === "string"));
    return whole ? { sealed: doc.values as Sealed } : { unreadable: "not a trigger settings file of version 1" };
  } catch (error) {
    return { unreadable: (error as Error).message };
  }
}

export class SealedSettings {
  private readonly file: string;
  private sealed: Sealed = {};
  /** Opened, by scope and field: read once at the start, then kept with every write. */
  private readonly opened: Record<string, Record<string, string>> = {};
  /** The values this store held open and no longer does, rotated or removed: in memory alone, for this process's life. */
  private readonly retired = new Set<string>();
  /** Why the file does not read: nothing is made, rotated or removed, nothing it holds is read, and it is never written over. */
  private readonly unreadable?: string;

  constructor(data: string, private readonly adapterId: string, private readonly spec: SettingsSpec, private readonly key: Buffer | undefined, say: (fields: Record<string, string>) => void) {
    this.file = join(data, settingsFile(adapterId));
    const read = sealedIn(this.file);
    if ("unreadable" in read) {
      this.unreadable = read.unreadable;
      say({ condition: "trigger_settings_unreadable", adapter: adapterId, file: this.file, error: read.unreadable });
      return;
    }
    this.sealed = read.sealed;
    if (!this.key && Object.values(this.sealed).some((fields) => Object.keys(fields).length)) {
      say({ condition: "trigger_settings_no_seal_key", adapter: adapterId, file: this.file, effect: `this server was handed no ${SEAL_KEY_ENV}: none of its sealed settings is read` });
    }
    for (const [scope, fields] of Object.entries(this.sealed)) {
      for (const [field, value] of Object.entries(fields)) {
        if (!this.key) continue;
        try {
          (this.opened[scope] ??= {})[field] = unseal(this.key, Buffer.from(value, "base64"), aad(adapterId, scope, field)).toString("utf8");
        } catch {
          say({ condition: "trigger_setting_unopened", adapter: adapterId, scope, field, file: this.file, effect: `it does not open under ${SEAL_KEY_ENV}: unset until it is set again` });
        }
      }
    }
  }

  /** A new secret for `scope`'s `field` (one the spec mints), written sealed before it is answered: its only showing. */
  mint(scope: string, field: string): string {
    if (!this.spec.fields[field]?.mint) throw new Error(`${this.adapterId}'s settings mint no ${field}`);
    const secret = mintSecret();
    this.put(scope, field, secret);
    return secret;
  }

  /** A given value for `scope`'s `field` (a sender's signing secret, a bot's token), written sealed. One under its
   *  field's `minBytes` is refused, 422, before anything is written. */
  set(scope: string, field: string, value: string): void {
    const spec = this.spec.fields[field];
    if (!spec) throw new Error(`${this.adapterId}'s settings keep no ${field}`);
    // A value the list of the server's secrets would pass over (server-secrets.ts: whitespace, under 8 bytes) would be
    // left out of every redaction: no secret like that is kept.
    if (!spec.public && (/\s/.test(value) || Buffer.byteLength(value, "utf8") < 8)) throw invalid([{ field, reason: "invalid", message: `${field} is at least 8 bytes, with no whitespace` }]);
    // A verification key is kept only as the spec writes one, or every request it checks would be refused.
    if (spec.minBytes === MIN_KEY_BYTES && !value.startsWith(SECRET_PREFIX)) throw invalid([{ field, reason: "invalid", message: `${field} is a Standard Webhooks secret: whsec_ and its key in base64` }]);
    if (spec.minBytes !== undefined && keyBytes(value) < spec.minBytes) throw invalid([{ field, reason: "too_short", message: `${field} holds at least ${spec.minBytes} bytes` }]);
    this.put(scope, field, value);
  }

  private put(scope: string, field: string, value: string): void {
    this.writable();
    this.write({ ...this.sealed, [scope]: { ...this.sealed[scope], [field]: seal(this.key!, Buffer.from(value, "utf8"), aad(this.adapterId, scope, field)).toString("base64") } });
    const was = this.opened[scope]?.[field];
    if (was !== undefined && was !== value && !this.spec.fields[field]?.public) this.retired.add(was);
    (this.opened[scope] ??= {})[field] = value;
  }

  /** Whether a value can be kept here: the server was handed a seal key, and the file reads. */
  canSeal(): boolean {
    return this.key !== undefined && !this.unreadable;
  }

  /** `scope`'s `field`, opened; undefined when it is not set, or does not open here. */
  get(scope: string, field: string): string | undefined {
    return this.opened[scope]?.[field];
  }

  /** A scope's settings gone (a deleted trigger's); with the file unreadable they stay in it, unread. */
  remove(scope: string): void {
    if (this.unreadable || !(scope in this.sealed)) return;
    const { [scope]: _, ...rest } = this.sealed;
    this.write(rest);
    for (const [field, value] of Object.entries(this.opened[scope] ?? {})) if (!this.spec.fields[field]?.public) this.retired.add(value);
    delete this.opened[scope];
  }

  /** Every value held open, and every one rotated or removed since this store opened, for the server's list of its own
   *  secrets (server-secrets.ts): a run that echoes a secret after its rotation is cut all the same. */
  values(): string[] {
    return [...Object.values(this.opened).flatMap((fields) => Object.entries(fields).flatMap(([field, value]) => (this.spec.fields[field]?.public ? [] : [value]))), ...this.retired];
  }

  private writable(): void {
    if (this.unreadable) throw new ApiError("store_unreadable", `${settingsFile(this.adapterId)} in the data directory does not read (${this.unreadable}); it is never written over, so no ${this.adapterId} trigger's secret is made or rotated. Fix it or move it away, then restart.`);
    if (!this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no ${this.adapterId} trigger's secret: it never keeps one in the clear.`);
  }

  private write(sealed: Sealed): void {
    writeDurableSync(this.file, `${JSON.stringify({ v: 1, values: sealed }, null, 2)}\n`);
    this.sealed = sealed;
  }
}
