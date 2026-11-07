// A trigger source's sealed settings (trigger-adapter.ts `settings`): the trigger kernel's one store of them. One file
// per adapter, DIR/trigger-settings-<adapter>.json, holding each scope's fields (the server's, or one trigger's, by its
// id) sealed under the seal key (tool-keys.ts), each bound to its adapter, scope and field by its AAD. With no seal key
// none is kept, never in the clear. A file that does not read is never written over: nothing is made or removed until
// it is fixed. A value that does not open under this server's seal key is said once, kept sealed as it is, and reads as
// unset.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { mintSecret } from "./standard-webhooks.js";
import { SEAL_KEY_ENV } from "./tool-keys.js";
import { isObject } from "./validate.js";

/** What an adapter keeps sealed, and where: `server`, one set for the server; `trigger`, one set per trigger, by its id.
 *  A field with `mint` is a Standard Webhooks secret this server makes (standard-webhooks.ts), shown once. */
export type SettingsSpec = { scope: "server" | "trigger"; fields: Record<string, { mint?: true }> };
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
    this.writable();
    const secret = mintSecret();
    this.write({ ...this.sealed, [scope]: { ...this.sealed[scope], [field]: seal(this.key!, Buffer.from(secret, "utf8"), aad(this.adapterId, scope, field)).toString("base64") } });
    (this.opened[scope] ??= {})[field] = secret;
    return secret;
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
    delete this.opened[scope];
  }

  /** Every value held open, for the server's list of its own secrets (server-secrets.ts). */
  values(): string[] {
    return Object.values(this.opened).flatMap((fields) => Object.values(fields));
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
