// The keys a person saves for this server's tools, by name, through /v2/settings/tool-keys. DIR/tool-keys.json (0600,
// written whole and synced, then renamed) holds them only as AES-256-GCM ciphertext (pi-durable-agent's `seal`) under the seal
// key the launcher hands the server (AGENTRUN_SEAL_KEY), which is never in the data directory: a copy of the directory
// holds ciphertext alone. Each value is bound to its field's name and this format, so one moved to another name does
// not open, and carries a check of the key it was sealed under (an HMAC of a fixed label, neither the key nor a hash of
// it), so a value sealed under another key reads as that, told apart from a damaged one. Only this process opens a
// value, when it is asked for. One that does not open is never a crash and never a clear fallback: it reads as not
// set, to be entered again, and the log says why once, naming the file, never a value. The server reads a saved value by
// name as it reads a launcher's secret (secrets.ts' `secret`), the launcher's winning: a run gets it over its pipe (a
// decision key on its decision descriptor) at its launch, and capabilities and checks see it once it is saved. A key is
// checked against its provider before it is kept (key-check.ts): one the provider refuses is never kept, and the file
// keeps, beside the sealed values, whether each key was accepted or kept not checked, and why (never any of a value).
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { decisionsOf } from "./decisions.js";
import { ApiError, invalid } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { HARNESSES } from "./harness.js";
import { checkKey, type KeyCheck } from "./key-check.js";
import { toolsView } from "./tools.js";
import { MODEL_KEYS } from "./model.js";
import { isObject, unknownFields } from "./validate.js";

export const TOOL_KEYS_FILE = "tool-keys.json";
export const SEAL_KEY_ENV = "AGENTRUN_SEAL_KEY";
const FORMAT = "tool-keys/1";
const MAX_VALUE_BYTES = 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Each key a person may save, fixed here: its kind, the fields it is entered as (BROWSERBASE_PROJECT_ID is no secret,
 *  and is kept the same way), and what it may unlock: tools by name, and `decisions.<id>`, a workflow's decision
 *  provider. GET lists only those this server binds (unlockedBy), so a name here the server does not bind is never
 *  promised, and one shows by itself once the server binds it. A `tool` key's fields reach only the runs that name a
 *  tool it unlocks (runs.ts' secretsFor); a key of any other kind (a model's) reaches every run. */
export const TOOL_KEYS = [
  { id: "parallel", kind: "tool", label: "Parallel", fields: ["PARALLEL_API_KEY"], unlocks: ["web_fetch", "web_search", "decisions.parallel"] },
  { id: "monid", kind: "tool", label: "Monid", fields: ["MONID_API_KEY"], unlocks: ["monid.discover", "monid.inspect", "monid.run"] },
  { id: "browserbase", kind: "tool", label: "Browserbase", fields: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"], unlocks: ["browser"] },
  // Jev's decision provider (decisions.ts' `jev`), on TypeSafe's key: a workflow's judges, as Parallel's key unlocks its.
  { id: "typesafe", kind: "tool", label: "TypeSafe (Jev)", fields: ["TYPESAFE_API_KEY"], unlocks: ["decisions.jev"] },
  // A model provider's key (model.ts' MODEL_KEYS, which give each its default model): every run gets it, as the
  // launcher's model keys reach every run. Its harnesses are pi and the harness that is the provider's own.
  ...MODEL_KEYS.map(({ id, label, field, harnesses }) => ({ id, kind: "model" as const, label, fields: [field] as const, unlocks: [] as const, harnesses })),
] as const;
const FIELDS: readonly string[] = TOOL_KEYS.flatMap((row) => row.fields);
/** The fields of the `tool` rows: keys a tool or a decision provider reads, and no harness (the harnesses read their
 *  packages, their pins and their models' keys). A row of another kind (a model's) is outside them. */
export const TOOL_FIELDS: readonly string[] = TOOL_KEYS.filter((row) => row.kind === "tool").flatMap((row) => row.fields);

/** What `candidates` unlock here, as capabilities show it: the tools of `tools` (capabilities' `tools`, available or
 *  not) and the providers of `providers` (its `workflows.decisions.providers`) named among them, and the harnesses
 *  that run those tools. A name neither holds is left out; a key that unlocks none of its names lists nothing. */
export function unlockedBy(candidates: readonly string[], tools: readonly { name: string; harnesses: readonly string[] }[], providers: readonly { id: string }[]) {
  const bound = new Set([...tools.map((tool) => tool.name), ...providers.map((provider) => `decisions.${provider.id}`)]);
  const unlocks = candidates.filter((name) => bound.has(name));
  const run = new Set(tools.filter((tool) => unlocks.includes(tool.name)).flatMap((tool) => tool.harnesses));
  return { unlocks, harnesses: HARNESSES.filter((harness) => run.has(harness)) };
}

/** What a row unlocks here: a `tool` row's, its tools and providers as capabilities bind them (unlockedBy); any other
 *  kind's (a model's), no tool, on those that run on it (its `harnesses`, when it names them) that this server runs
 *  (`offers`, harness.ts' harnessOffers) or would once its key is set: one unavailable only for want of a model key
 *  among whose `keys` is the row's (its first field). So OpenRouter's row names all three before any key is saved; a
 *  harness not installed, off its pins or too big for this host is left out. */
export function rowUnlocks(row: { kind: string; unlocks: readonly string[]; harnesses?: readonly string[]; fields?: readonly string[] }, tools: Parameters<typeof unlockedBy>[1], providers: Parameters<typeof unlockedBy>[2], offers: readonly { id: string; available: boolean; keys?: readonly string[] }[]) {
  if (row.kind === "tool") return unlockedBy(row.unlocks, tools, providers);
  const key = row.fields?.[0];
  const runs = (harness: string) => offers.some((offer) => offer.id === harness && (offer.available || (key !== undefined && offer.keys?.includes(key) === true)));
  return { unlocks: [] as string[], harnesses: HARNESSES.filter((harness) => (row.harnesses ?? HARNESSES).includes(harness) && runs(harness)) };
}

/** The key that unlocks the tool `name` (capabilities' `tools[].key`, so a page links "needs the X key" to it), if any. */
export const keyOf = (name: string): string | undefined => TOOL_KEYS.find((row) => (row.unlocks as readonly string[]).includes(name))?.id;

/** Why a stored value does not open, in the order a re-entry names one: no seal key now, another than it was sealed
 *  under, or the file (or its entry) damaged. */
export const UNREADABLE = ["seal_key_missing", "seal_key_changed", "file_unreadable"] as const;
type Unreadable = (typeof UNREADABLE)[number];
type Opened = { value: string } | { unreadable: Unreadable };
/** The file's entries: each field's sealed value by name, and each key's check by id. */
type Kept = { fields: Record<string, unknown>; checks: Record<string, KeyCheck> };

/** The check of a key the server was started with (ToolKeys.checkServer): a KeyCheck, or refused by its provider, why in
 *  plain words. Held in memory only, for this start. */
export type StartCheck = KeyCheck | { state: "refused"; reason: string; at: string };

/** The check a key kept before this server checked keys reads as: none was made. */
const UNCHECKED: KeyCheck = { state: "not_checked", reason: "Saved before this server checked keys; save it again to check it" };
/** A check as the file keeps it, else undefined. */
const keptCheck = (entry: unknown): KeyCheck | undefined =>
  !isObject(entry) ? undefined
  : entry.state === "accepted" && typeof entry.at === "string" ? { state: "accepted", at: entry.at }
  : entry.state === "not_checked" && typeof entry.reason === "string" ? { state: "not_checked", reason: entry.reason, ...(typeof entry.at === "string" ? { at: entry.at } : {}) }
  : undefined;

/** The seal key `text` gives: 32 bytes in base64 (or base64url), else none. */
export function sealKeyOf(text: string | undefined): Buffer | undefined {
  const trimmed = text?.trim() ?? "";
  return /^[A-Za-z0-9+/_-]{43}=?$/.test(trimmed) ? Buffer.from(trimmed, "base64") : undefined;
}

const aad = (name: string) => `${FORMAT}|${name}`;

export class ToolKeys {
  readonly file: string;
  private readonly key: Buffer | undefined;
  private readonly sealCheck: string | undefined;
  private said = "";
  /** The checks of the keys the server was started with, by key id, each once it answered (checkServer). */
  private readonly started: Record<string, StartCheck> = {};

  /** `env` is what the server is started with (withSecrets' `"own"`, never a saved key, or each would read as the
   *  server's and could not be deleted): a field it sets is the server's, and wins. `say` takes a log line's fields. */
  constructor(data: string, private readonly env: NodeJS.ProcessEnv, private readonly say: (fields: Record<string, string>) => void) {
    this.file = join(data, TOOL_KEYS_FILE);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    this.sealCheck = this.key && createHmac("sha256", this.key).update(`agentrun-serve ${FORMAT} key check`).digest("base64url");
    if (env[SEAL_KEY_ENV] !== undefined && !this.key) say({ condition: "seal_key_invalid", name: SEAL_KEY_ENV });
  }

  /** The file's entries, none with no file; "unreadable" when it does not read as this format. A file from before checks
   *  has none. */
  private kept(): Kept | "unreadable" {
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!isObject(doc) || doc.v !== 1 || !isObject(doc.fields)) return "unreadable";
      const checks = Object.entries(isObject(doc.checks) ? doc.checks : {}).flatMap(([id, entry]) => {
        const check = keptCheck(entry);
        return check ? [[id, check] as const] : [];
      });
      return { fields: { ...doc.fields }, checks: Object.fromEntries(checks) };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { fields: {}, checks: {} } : "unreadable";
    }
  }

  private open(name: string, entry: unknown): Opened {
    if (!this.key) return { unreadable: "seal_key_missing" };
    if (!isObject(entry) || typeof entry.sealed !== "string" || typeof entry.check !== "string") return { unreadable: "file_unreadable" };
    if (entry.check !== this.sealCheck) return { unreadable: "seal_key_changed" };
    try {
      return { value: unseal(this.key, Buffer.from(entry.sealed, "base64"), aad(name)).toString("utf8") };
    } catch {
      return { unreadable: "file_unreadable" };
    }
  }

  /** The stored value of the field `name`, opened now (secrets.ts reads a saved key by name through this); undefined
   *  with none, or one that does not open, which view() asks for again: never a clear fallback. */
  value(name: string): string | undefined {
    if (!FIELDS.includes(name)) return undefined;
    const kept = this.kept();
    const opened = kept !== "unreadable" && kept.fields[name] !== undefined ? this.open(name, kept.fields[name]) : undefined;
    return opened && "value" in opened ? opened.value : undefined;
  }

  /** Every stored value that opens, by field name. */
  values(): Record<string, string> {
    return Object.fromEntries(FIELDS.flatMap((name) => {
      const value = this.value(name);
      return value === undefined ? [] : [[name, value] as const];
    }));
  }

  /** GET: each key's fields, whether set and where from (never a value), what it unlocks of what capabilities shows
   *  here (a model key: the harnesses `offers` says this server runs or would on the key), its check when its key (its first field) is
   *  stored here (null otherwise: the server's own is not checked here), and what to enter again, with why. */
  view(offers: Parameters<typeof rowUnlocks>[3] = []) {
    const kept = this.kept();
    const again: { name: string; why: Unreadable }[] = [];
    const tools = toolsView(this.env);
    const providers = decisionsOf(this.env);
    const keys = TOOL_KEYS.map((row) => {
      const fields = row.fields.map((name) => {
        if (this.env[name]) return { name, set: true, source: "server" as const };
        const opened = kept !== "unreadable" && kept.fields[name] !== undefined ? this.open(name, kept.fields[name]) : undefined;
        if (opened && "value" in opened) return { name, set: true, source: "stored" as const };
        if (opened) again.push({ name, why: opened.unreadable });
        return { name, set: false, source: null, ...(opened ? { stored_unreadable: true as const } : {}) };
      });
      const check = fields[0].source === "stored" && kept !== "unreadable" ? (kept.checks[row.id] ?? UNCHECKED) : fields[0].source === "server" ? (this.started[row.id] ?? null) : null;
      return { id: row.id, kind: row.kind, label: row.label, ...rowUnlocks(row, tools, providers, offers), fields, check };
    });
    // A file that does not read as a whole names no field: which it held is unknown.
    const reason = kept === "unreadable" ? "file_unreadable" : UNREADABLE.find((why) => again.some((field) => field.why === why));
    const reenter = reason ? { reason, fields: again.map((field) => field.name) } : null;
    const said = JSON.stringify(reenter);
    if (reenter && said !== this.said) this.say({ condition: reenter.reason, file: this.file, fields: reenter.fields.join(",") || "unknown" });
    this.said = said;
    return { keys, reenter };
  }

  /** Each tool key the server is started with (a `tool` row whose key, its first field, the server sets), checked against
   *  its provider once, as a saved one is (key-check.ts), through the fetch `fetchFor` gives for the row (null: not
   *  checked, its check stays null); all at once, none holding up another or the start. `answered` is called as each
   *  answers, unless `stop` (the server closing) came first. A model key is not checked here: a run on a refused one
   *  fails at its first request, saying so. */
  async checkServer(fetchFor: (id: string) => Promise<typeof fetch | null>, stop: AbortSignal, answered: () => void): Promise<void> {
    await Promise.all(TOOL_KEYS.filter((row) => row.kind === "tool" && this.env[row.fields[0]]).map(async (row) => {
      const name = row.fields[0];
      const fetcher = await fetchFor(row.id);
      if (!fetcher) return;
      const outcome = await checkKey(row, this.env[name] as string, this.env, fetcher, undefined, stop, name).catch(() => undefined);
      if (!outcome || stop.aborted) return;
      this.started[row.id] = outcome.state === "refused" ? { state: "refused", reason: `${outcome.message} when this server started: set the right one where AgentRun starts, then restart it`, at: new Date().toISOString() } : outcome;
      answered();
    }));
  }

  /** The variables of the keys the server was started with that their provider refused at the start, each with why
   *  (capabilities' tools that need one read unavailable: tools.ts toolsView). */
  refused(): Record<string, string> {
    return Object.fromEntries(TOOL_KEYS.flatMap((row) => {
      const check = this.started[row.id];
      return check?.state === "refused" ? [[row.fields[0], check.reason] as const] : [];
    }));
  }

  /** A PUT's check, before save(): the key it sends (its row's first field; Browserbase's project id is no key) checked
   *  against its provider (key-check.ts), the fetch `fetchFor` gives for the row (undefined: none, so not checked), its
   *  wait cut by `stop`. The body is held to what save() takes first, so a save that would be refused sends nothing. A
   *  key the provider refuses is 422 in its words, and nothing is kept; undefined when the body sends no key: the row's
   *  check stays as it was. */
  async check(id: string, body: Record<string, unknown>, fetchFor: (id: string) => Promise<typeof fetch | undefined>, stop?: AbortSignal): Promise<KeyCheck | undefined> {
    const { row, values } = this.admit(id, body);
    const name = row.fields[0];
    if (values[name] === undefined) return undefined;
    const outcome = await checkKey(row, values[name] as string, this.env, await fetchFor(row.id), undefined, stop);
    if (outcome.state === "refused") throw invalid([{ field: `values.${name}`, reason: "refused_by_provider", message: outcome.message }]);
    return outcome;
  }

  /** PUT: each of `body.values` sealed under the seal key, and `check` (check()'s) kept for the key when given; the key's
   *  other fields stay as they are. A key saved with no check (a caller other than the route) drops the one it had. */
  save(id: string, body: Record<string, unknown>, check?: KeyCheck): void {
    const { row, values } = this.admit(id, body);
    const kept = this.kept();
    // A file that does not read is replaced: what it held opens nowhere.
    const { fields, checks }: Kept = kept === "unreadable" ? { fields: {}, checks: {} } : kept;
    for (const [name, value] of Object.entries(values)) fields[name] = { sealed: seal(this.key!, Buffer.from(value as string, "utf8"), aad(name)).toString("base64"), check: this.sealCheck };
    if (values[row.fields[0]] !== undefined) delete checks[row.id];
    if (check) checks[row.id] = check;
    this.write(fields, checks);
  }

  /** What a PUT may save: the key's row and the body's values, or 422 (the body), 409 (a field the server's, or no seal
   *  key). No message holds a value, or any part of one. */
  private admit(id: string, body: Record<string, unknown>) {
    const row = this.row(id);
    const issues = unknownFields(body, ["values"]);
    const values = isObject(body.values) ? body.values : {};
    if (!Object.keys(values).length) issues.push({ field: "values", reason: body.values === undefined ? "missing" : "wrong_type", message: `values holds one or more of ${row.fields.join(", ")}, by name` });
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
    return { row, values };
  }

  /** DELETE: the key's stored fields gone, and its check. Refused only when the server sets every field of it: none is
   *  the page's. */
  remove(id: string): void {
    const row = this.row(id);
    if (row.fields.every((name) => this.env[name])) this.notServers(row.fields);
    const kept = this.kept();
    if (kept !== "unreadable" && !row.fields.some((name) => name in kept.fields)) return;
    const { fields, checks }: Kept = kept === "unreadable" ? { fields: {}, checks: {} } : kept;
    for (const name of row.fields) delete fields[name];
    delete checks[row.id];
    this.write(fields, checks);
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

  private write(fields: Record<string, unknown>, checks: Record<string, KeyCheck>): void {
    // On disk, the file and then its directory, before the 204: a crash after it neither loses a saved key nor brings
    // back a forgotten one.
    writeDurableSync(this.file, `${JSON.stringify({ v: 1, fields, checks }, null, 2)}\n`);
  }
}
