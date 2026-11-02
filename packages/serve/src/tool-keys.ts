// The keys a person saves for this server's tools, by name, through /v2/settings/tool-keys. DIR/tool-keys.json (0600,
// written whole and synced, then renamed) holds them only as AES-256-GCM ciphertext (pi-durable-agent's `seal`) under the seal
// key the launcher hands the server (AGENTRUN_SEAL_KEY), which is never in the data directory: a copy of the directory
// holds ciphertext alone. Each value is bound to its field's name and this format, so one moved to another name does
// not open, and carries a check of the key it was sealed under (an HMAC of a fixed label, neither the key nor a hash of
// it), so a value sealed under another key reads as that, told apart from a damaged one. Only this process opens a
// value, when it is asked for. One that does not open is never a crash and never a clear fallback: it reads as not
// set, to be entered again, and the log says why once, naming the file, never a value.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { DEFAULT_HARNESS, HARNESSES } from "./harness.js";
import { isObject } from "./validate.js";

export const TOOL_KEYS_FILE = "tool-keys.json";
export const SEAL_KEY_ENV = "AGENTRUN_SEAL_KEY";
const FORMAT = "tool-keys/1";
const MAX_VALUE_BYTES = 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Each key a person may save, fixed here: the fields it is entered as (BROWSERBASE_PROJECT_ID is no secret, and is
 *  kept the same way), what it unlocks, and the harnesses that run what it unlocks. */
export const TOOL_KEYS = [
  { id: "parallel", label: "Parallel", fields: ["PARALLEL_API_KEY"], unlocks: ["web_fetch", "web_search", "decisions.parallel"], harnesses: [...HARNESSES] },
  // pi only until the monid tools are host tools (tools.ts, host-tools.ts): what capabilities say of them.
  { id: "monid", label: "Monid", fields: ["MONID_API_KEY"], unlocks: ["monid.discover", "monid.inspect", "monid.run"], harnesses: [DEFAULT_HARNESS] },
  { id: "browserbase", label: "Browserbase", fields: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"], unlocks: ["browser"], harnesses: [DEFAULT_HARNESS] },
] as const;
const FIELDS: readonly string[] = TOOL_KEYS.flatMap((row) => row.fields);

/** Why a stored value does not open, in the order a re-entry names one: no seal key now, another than it was sealed
 *  under, or the file (or its entry) damaged. */
export const UNREADABLE = ["seal_key_missing", "seal_key_changed", "file_unreadable"] as const;
type Unreadable = (typeof UNREADABLE)[number];
type Opened = { value: string } | { unreadable: Unreadable };

/** The seal key `text` gives: 32 bytes in base64 (or base64url), else none. */
export function sealKeyOf(text: string | undefined): Buffer | undefined {
  const trimmed = text?.trim() ?? "";
  return /^[A-Za-z0-9+/_-]{43}=?$/.test(trimmed) ? Buffer.from(trimmed, "base64") : undefined;
}

const aad = (name: string) => `${FORMAT}|${name}`;

export class ToolKeys {
  readonly file: string;
  private readonly key: Buffer | undefined;
  private readonly check: string | undefined;
  private said = "";

  /** `env` is the server's own (withSecrets): a field it sets is the server's, and wins. `say` takes a log line's fields. */
  constructor(data: string, private readonly env: NodeJS.ProcessEnv, private readonly say: (fields: Record<string, string>) => void) {
    this.file = join(data, TOOL_KEYS_FILE);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    this.check = this.key && createHmac("sha256", this.key).update(`agentrun-serve ${FORMAT} key check`).digest("base64url");
    if (env[SEAL_KEY_ENV] !== undefined && !this.key) say({ condition: "seal_key_invalid", name: SEAL_KEY_ENV });
  }

  /** The file's entries by field name, {} with no file; "unreadable" when it does not read as this format. */
  private kept(): Record<string, unknown> | "unreadable" {
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return isObject(doc) && doc.v === 1 && isObject(doc.fields) ? { ...doc.fields } : "unreadable";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : "unreadable";
    }
  }

  private open(name: string, entry: unknown): Opened {
    if (!this.key) return { unreadable: "seal_key_missing" };
    if (!isObject(entry) || typeof entry.sealed !== "string" || typeof entry.check !== "string") return { unreadable: "file_unreadable" };
    if (entry.check !== this.check) return { unreadable: "seal_key_changed" };
    try {
      return { value: unseal(this.key, Buffer.from(entry.sealed, "base64"), aad(name)).toString("utf8") };
    } catch {
      return { unreadable: "file_unreadable" };
    }
  }

  /** GET: each key's fields, whether set and where from (never a value), and what to enter again, with why. */
  view() {
    const kept = this.kept();
    const again: { name: string; why: Unreadable }[] = [];
    const keys = TOOL_KEYS.map((row) => ({
      id: row.id, label: row.label, unlocks: [...row.unlocks], harnesses: [...row.harnesses],
      fields: row.fields.map((name) => {
        if (this.env[name]) return { name, set: true, source: "server" as const };
        const opened = kept !== "unreadable" && kept[name] !== undefined ? this.open(name, kept[name]) : undefined;
        if (opened && "value" in opened) return { name, set: true, source: "stored" as const };
        if (opened) again.push({ name, why: opened.unreadable });
        return { name, set: false, source: null, ...(opened ? { stored_unreadable: true as const } : {}) };
      }),
    }));
    // A file that does not read as a whole names no field: which it held is unknown.
    const reason = kept === "unreadable" ? "file_unreadable" : UNREADABLE.find((why) => again.some((field) => field.why === why));
    const reenter = reason ? { reason, fields: again.map((field) => field.name) } : null;
    const said = JSON.stringify(reenter);
    if (reenter && said !== this.said) this.say({ condition: reenter.reason, file: this.file, fields: reenter.fields.join(",") || "unknown" });
    this.said = said;
    return { keys, reenter };
  }

  /** PUT: each of `body.values` sealed under the seal key; the key's other fields stay as they are. */
  save(id: string, body: Record<string, unknown>): void {
    const row = this.row(id);
    const issues: InputIssue[] = Object.keys(body).filter((key) => key !== "values").map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));
    const values = isObject(body.values) ? body.values : {};
    if (!Object.keys(values).length) issues.push({ field: "values", reason: body.values === undefined ? "missing" : "wrong_type", message: `values holds one or more of ${row.fields.join(", ")}, by name` });
    // No message holds a value, or any part of one.
    for (const [name, value] of Object.entries(values)) {
      const field = `values.${name}`;
      if (!(row.fields as readonly string[]).includes(name)) issues.push({ field, reason: "not_allowed", message: `The key ${row.id} has the fields ${row.fields.join(", ")}.` });
      else if (typeof value !== "string" || value === "") issues.push({ field, reason: "wrong_type", message: `${name} is text, not empty` });
      else if (CONTROL.test(value)) issues.push({ field, reason: "invalid", message: `${name} holds a control character` });
      else if (Buffer.byteLength(value) > MAX_VALUE_BYTES) issues.push({ field, reason: "too_long", message: `${name} is at most ${MAX_VALUE_BYTES} bytes` });
    }
    if (issues.length) throw invalid(issues);
    this.notServers(Object.keys(values));
    if (!this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no tool key: it never keeps one in the clear.`);
    const kept = this.kept();
    // A file that does not read is replaced: what it held opens nowhere.
    const fields = kept === "unreadable" ? {} : kept;
    for (const [name, value] of Object.entries(values)) fields[name] = { sealed: seal(this.key, Buffer.from(value as string, "utf8"), aad(name)).toString("base64"), check: this.check };
    this.write(fields);
  }

  /** DELETE: the key's stored fields gone. Refused only when the server sets every field of it: none is the page's. */
  remove(id: string): void {
    const row = this.row(id);
    if (row.fields.every((name) => this.env[name])) this.notServers(row.fields);
    const kept = this.kept();
    if (kept !== "unreadable" && !row.fields.some((name) => name in kept)) return;
    const fields = kept === "unreadable" ? {} : kept;
    for (const name of row.fields) delete fields[name];
    this.write(fields);
  }

  private row(id: string) {
    const row = TOOL_KEYS.find((r) => r.id === id);
    if (!row) throw invalid([{ field: "key_id", reason: "not_an_option", message: `The tool keys are ${TOOL_KEYS.map((r) => r.id).join(", ")}.` }]);
    return row;
  }

  /** 409 when this server's own environment (its launcher) sets one of `names`: that one wins, and is changed where the
   *  server is started. */
  private notServers(names: readonly string[]): void {
    const held = names.filter((name) => this.env[name]);
    if (held.length) throw new ApiError("key_set_by_server", `This server is started with ${held.join(" and ")}: change it where the server is started.`, { details: { fields: held } });
  }

  private write(fields: Record<string, unknown>): void {
    // On disk, the file and then its directory, before the 204: a crash after it neither loses a saved key nor brings
    // back a forgotten one.
    writeDurableSync(this.file, `${JSON.stringify({ v: 1, fields }, null, 2)}\n`);
  }
}
