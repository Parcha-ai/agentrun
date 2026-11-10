// A trigger source's sealed settings (trigger-adapter.ts `settings`): the trigger kernel's one store of them. One file
// per adapter, DIR/trigger-settings-<adapter>.json, holding each scope's fields (the server's, or one trigger's, by its
// id) sealed under the seal key (tool-keys.ts), each bound to its adapter, scope and field by its AAD. There is always a
// seal key (seal-key.ts), so none is kept in the clear. A file that does not read is never written over: nothing is made or removed until
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
 *  a request is verified with. `public`: a value that is no secret (an app's id, its name), kept with the rest but never
 *  in the list of the server's secrets, so no run's text is cut of it, and of any length. `format: "pem"`: a PEM private
 *  key, whose lines each are listed as secrets. */
export type SettingsSpec = { scope: "server" | "trigger"; fields: Record<string, { mint?: true; minBytes?: number; public?: true; format?: "pem" }> };
/** A PEM private key, whole: its BEGIN line, its base64 lines, its END line. */
const PEM = /^-----BEGIN ((?:[A-Z]+ )*)PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1PRIVATE KEY-----\s*$/;
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
  /** The PEM keys this store held open and no longer does: in memory alone, listed by pemValues. */
  private readonly retiredPem: string[] = [];
  /** Why the file does not read: nothing is made, rotated or removed, nothing it holds is read, and it is never written over. */
  private readonly unreadable?: string;

  constructor(data: string, private readonly adapterId: string, private readonly spec: SettingsSpec, private readonly key: Buffer, say: (fields: Record<string, string>) => void) {
    this.file = join(data, settingsFile(adapterId));
    const read = sealedIn(this.file);
    if ("unreadable" in read) {
      this.unreadable = read.unreadable;
      say({ condition: "trigger_settings_unreadable", adapter: adapterId, file: this.file, error: read.unreadable });
      return;
    }
    this.sealed = read.sealed;
    for (const [scope, fields] of Object.entries(this.sealed)) {
      for (const [field, value] of Object.entries(fields)) {
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
    if (spec.format === "pem" && !PEM.test(value)) throw invalid([{ field, reason: "invalid", message: `${field} is a PEM private key` }]);
    // A value the list of the server's secrets would pass over (server-secrets.ts: whitespace, under 8 bytes) would be
    // left out of every redaction: none is kept. A public one is no secret; a PEM key is listed by its lines.
    if (!spec.public && spec.format !== "pem" && (/\s/.test(value) || Buffer.byteLength(value, "utf8") < 8)) throw invalid([{ field, reason: "invalid", message: `${field} is at least 8 bytes, with no whitespace` }]);
    // A verification key is kept only as the spec writes one, or every request it checks would be refused.
    if (spec.minBytes === MIN_KEY_BYTES && !value.startsWith(SECRET_PREFIX)) throw invalid([{ field, reason: "invalid", message: `${field} is a Standard Webhooks secret: whsec_ and its key in base64` }]);
    if (spec.minBytes !== undefined && keyBytes(value) < spec.minBytes) throw invalid([{ field, reason: "too_short", message: `${field} holds at least ${spec.minBytes} bytes` }]);
    this.put(scope, field, value);
  }

  private put(scope: string, field: string, value: string): void {
    this.writable();
    this.write({ ...this.sealed, [scope]: { ...this.sealed[scope], [field]: seal(this.key, Buffer.from(value, "utf8"), aad(this.adapterId, scope, field)).toString("base64") } });
    const was = this.opened[scope]?.[field];
    if (was !== undefined && was !== value) this.retire(field, was);
    (this.opened[scope] ??= {})[field] = value;
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
    for (const [field, value] of Object.entries(this.opened[scope] ?? {})) this.retire(field, value);
    delete this.opened[scope];
  }

  /** Every value held open, and every one rotated or removed since this store opened, for the server's list of its own
   *  secrets (server-secrets.ts): a run that echoes a secret after its rotation is cut all the same. */
  values(): string[] {
    return [...Object.values(this.opened).flatMap((fields) => Object.entries(fields).flatMap(([field, value]) => this.secretsOf(field, value))), ...this.retired];
  }

  /** What of `field`'s `value` is a secret to list with a floor (server-secrets.ts): none for a public field or a PEM key
   *  (pemValues lists that), else the value. */
  private secretsOf(field: string, value: string): string[] {
    const spec = this.spec.fields[field];
    if (spec?.public || spec?.format === "pem") return [];
    return [value];
  }

  /** Every PEM key held open, or rotated or removed since this store opened: each whole and each of its base64 lines,
   *  the short last one too, listed with no floor (server-secrets.ts `whole`). */
  pemValues(): string[] {
    const pem = (field: string) => this.spec.fields[field]?.format === "pem";
    const forms = (value: string) => [value, ...value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("-----"))];
    return [...Object.values(this.opened).flatMap((fields) => Object.entries(fields).filter(([field]) => pem(field)).flatMap(([, value]) => forms(value))), ...this.retiredPem.flatMap(forms)];
  }

  private retire(field: string, value: string): void {
    if (this.spec.fields[field]?.format === "pem") this.retiredPem.push(value);
    else for (const secret of this.secretsOf(field, value)) this.retired.add(secret);
  }

  /** Why nothing can be written here (a file that does not read), as the refusal a write would throw;
   *  undefined when one can be. */
  unwritable(): ApiError | undefined {
    try {
      this.writable();
      return undefined;
    } catch (error) {
      return error as ApiError;
    }
  }

  private writable(): void {
    if (this.unreadable) throw new ApiError("store_unreadable", `${settingsFile(this.adapterId)} in the data directory does not read (${this.unreadable}); it is never written over, so no ${this.adapterId} trigger's secret is made or rotated. Fix it or move it away, then restart.`);
  }

  private write(sealed: Sealed): void {
    writeDurableSync(this.file, `${JSON.stringify({ v: 1, values: sealed }, null, 2)}\n`);
    this.sealed = sealed;
  }
}
