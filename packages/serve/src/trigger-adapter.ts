// What a trigger source is to the engine (triggers.ts): one adapter, declared once. Its id is the source's kind, the
// `by` of the firings it delivers and the tag of the payload a pushed firing passes on. The engine, the capabilities and
// the OpenAPI document read every list of sources from the registry (trigger-adapters.ts), so a new source is one
// adapter file and one line there.
import type { InputIssue } from "./errors.js";
import type { SettingsSpec } from "./sealed-settings-store.js";
import { unknownFields } from "./validate.js";

type Json = Record<string, unknown>;
/** Whether a run `adapter`'s firing starts is handed its trigger's last completed result: the one place it is decided
 *  (its previousResult, by default true). */
export const carriesPrevious = (adapter: Pick<TriggerAdapter, "previousResult">): boolean => adapter.previousResult ?? true;

/** The most of a firing's payload passed on, in bytes of UTF-8 (triggers.ts cuts past it, at a character's start). A
 *  source that answers JSON fits its payload within it first (trigger-email.ts), so its JSON is never cut. */
export const PAYLOAD_KEPT_BYTES = 16 * 1024;
/** A source as the store keeps it: its kind, the adapter's id, and the adapter's own fields. */
export type Source = { kind: string } & Json;

/** The times of a source that fires on a clock, made once for one reading of it (a cron line is parsed once). */
export type Clock = {
  /** Its first time strictly after `after`, or null when it has none. */
  next(after: number): number | null;
  /** Its latest time at or before `now`, given one that is (`first`), found without walking to it. */
  latest(first: number, now: number): number;
  /** A fixed interval between its times, when it has one: missed times are then counted, not walked. */
  step?: number;
};

export type TriggerAdapter = {
  /** The source's kind: `source.kind`, the `by` of its firings, the payload's tag. */
  id: string;
  /** How a person names one: `the <label> "<name>"`, in each run's provenance line. */
  label: string;
  /** `clock`: it fires on its own times, read by the engine's timer (a source that polls, on each). `push`: a request delivered to the server fires it,
   *  keyed by the sender's own id, which a retry repeats. */
  delivery: "clock" | "push";
  /** Whether a run it starts is handed its trigger's last completed result (trigger-targets.ts previousResultOf). Default
   *  true: a repeat run (a schedule's weekly digest) leaves out what the last one reported. false: each firing is a
   *  different person's (an email's sender), so one run's answer is never handed to the next. */
  previousResult?: boolean;
  /** Whether its words are its owner's (a run's message origin `owner`): true only when the owner wrote them as they set
   *  it up; never for words that come from outside. */
  owner: boolean;
  /** What it keeps sealed (sealed-settings-store.ts), for the server or for each trigger: a field it mints (a signing secret)
   *  is made at a trigger's create and at a rotation, shown once, and goes with the trigger. */
  settings?: SettingsSpec;
  /** Whether a trigger of this source keeps a secret its sender gave (a create's and a rotation's `secret`, Composio's)
   *  instead of one this server mints: then the secret is required there, sealed as a minted one is, and never made
   *  here. Default: it mints. */
  givesSecret?(source: Source): boolean;
  /** Its shapes as a create's error names them: `{kind: "..."}` with its fields. */
  describe: string;
  /** When it fires, for the OpenAPI document's source description. */
  fires: string;
  /** What a firing of it is, for the OpenAPI document's firing `by`. */
  firedBy?: string;
  /** Its shapes as JSON Schema, each a closed object with `kind` its id: the OpenAPI document's source oneOf. */
  schemas: ObjectSchema[];
  /** Its shapes as a trigger's view sends them, when the server fills in fields a write may leave out (a schedule's zone
   *  and start). Default `schemas`: a field the write left out stays out. */
  sent?: ObjectSchema[];
  /** A source given at a create or a PATCH (`value.kind` is its id), checked: each issue added through `bad`, with its
   *  field under `source`. Undefined when it does not read. */
  parse(value: Json, now: number, bad: (field: string, reason: string, message: string) => void, issues: InputIssue[]): Source | undefined;
  /** Whether a source the store keeps is whole, of its type. */
  wellFormed(source: Json): boolean;
  /** The zone its times are read in, for its runs' provenance line. Default UTC. */
  zone?(source: Source): string;
  /** A clock source's times. */
  clock?(source: Source): Clock;
  /** Why a source kept in the file no longer reads on this server, if it does not: its trigger is turned off, alone. */
  problem?(source: Source): string | undefined;
  /** A pushed source's requests (push-handler.ts), served at /v2/hooks/{trigger_id} when its settings are a trigger's,
   *  else at /v2/hooks/{its id}, with no token: the request's check is its credential. */
  push?: Push;
  /** For a pushed source whose hook is not the one its settings' scope gives (a source that keeps a key per scope, served
   *  at /v2/hooks/{its id}/{scope}): the path under /v2/hooks/ a trigger of `source` is delivered at, its `hook_url`. */
  hookOf?(source: Source): string;
  /** For a pushed source whose settings are the server's: the scope a trigger of it listens on, matched to each event's
   *  `scope` to find the triggers it fires. */
  scopeOf?(source: Source): string;
  /** For a pushed source whose settings are the server's and whose triggers each choose their own events (no scope): why
   *  a trigger of `source` does not take `event`, or undefined when it does. Every trigger that takes an event fires, each
   *  its own firing; triggers may take the same events. */
  takes?(source: Source, event: PushEvent): string | undefined;
  /** Whether each firing of a trigger of `source` starts its own run, its last run active or not (a webhook that takes
   *  only the events it names). Default false: a firing while the last run is active is skipped. */
  concurrent?(source: Source): boolean;
  /** For a clock source that polls (the email trigger): what it finds when its time comes, read from outside the server.
   *  The engine fires each event it returns through the path a pushed event takes (`takes`, `concurrent`,
   *  max_active_runs, the day-kept keys, a run per event), records no `missed` row for a time it was not there for, and
   *  keeps the poll's cursor once its firings are recorded. */
  poll?(source: Source, ctx: PollContext): Promise<PollResult>;
  /** For a source that polls: where its trigger starts watching, taken when the trigger is made, when an edit changes one
   *  of its source's `on` fields and when it is turned on again; never at its first poll. An edit of any other field keeps
   *  the cursor. A start not taken (the source unreachable, or slower than the engine waits) leaves no cursor: the first
   *  poll that reads the source takes it, and says so. */
  start?: Start;
  /** A run's title after its trigger's name, from what its source says of the firing (its attrs): an email's sender and
   *  subject. Default: the event and action the attrs name. */
  title?(attrs: Record<string, string>): string | undefined;
};

/** Why a start is taken: the trigger was made, an edit changed where it reads, or it was turned on again. */
export type StartWhy = "created" | "edited" | "enabled";
/** What a start is given: its trigger, why, and the source's credentials, read now (as a poll's). */
export type StartContext = { trigger: string; why: StartWhy; credentials(): Promise<unknown> };
/** What a start found: `check`, said on the trigger as its last check (a refusal here never counts toward turning it
 *  off); `note`, the history line it writes; `cursor`, the settings it starts from, none when it could not read the
 *  source. */
export type StartResult = { check: { ok: boolean; message: string }; note: string; cursor?: Record<string, string> };
export type Start = {
  /** The source's fields an edit of which takes a new start. */
  on: readonly string[];
  take(source: Source, ctx: StartContext): Promise<StartResult>;
  /** The words of a start the engine stopped waiting for. */
  unchecked(source: Source, why: StartWhy): string;
};
/** What a poll is given: its trigger's own settings (its cursor, public, as the adapter's `settings` names them) and the
 *  source's credentials, read now (TriggerDeps.credentials: the email account, opened). */
export type PollContext = { trigger: string; setting(field: string): string | undefined; credentials(): Promise<unknown> };
/** One event a poll found: a pushed event's fields; `cursor`, the settings to keep once it and every event before it are
 *  recorded; `left`, when it is recorded as skipped and starts nothing, why (in words). */
export type PolledEvent = PushEvent & { cursor: Record<string, string>; left?: string };
/** What a poll found: `check`, said on the trigger as its last check; `refused`, the source's credentials refused (the
 *  engine turns the trigger off at the third in a row, `detail` its words); `note`, one history line that starts no run
 *  (a first poll's, a reset's); `events`, oldest first; `cursor`, the settings to keep once every event is recorded. */
export type PollResult = { check: { ok: boolean; message: string }; refused?: { detail: string }; note?: string; events?: PolledEvent[]; cursor?: Record<string, string> };

/** Request headers, as Node gives them. */
export type Headers = Record<string, string | string[] | undefined>;
/** How a pushed source's requests are taken, in this order: its headers, its body (at most maxBodyBytes), its check
 *  against its settings' `key`, its handshake, its parse. Every refusal is the one 401. `source`: on a trigger's own path,
 *  the trigger's source when it names one of this kind that is on; else undefined. */
export type Push = {
  maxBodyBytes: number;
  /** The settings field it checks a request with. */
  key: string;
  /** For a source whose settings are the server's: it keeps its key per scope (a Composio project's subscription, by its
   *  hook), and is served at /v2/hooks/{its id}/{scope} alone, each request checked with that scope's key; its events'
   *  `scope` is that scope, for its takes. */
  scoped?: true;
  /** Why the headers alone are refused, before a byte of the body is read. */
  headers?(headers: Headers, nowMs: number): string | undefined;
  /** Why the request is not the sender's under `key`, or undefined when it is (and fits `source`, when given). */
  verify(key: string, headers: Headers, body: Buffer, nowMs: number, source?: Source): string | undefined;
  /** An answer of its own, after the check and before the parse (a sender's URL check, a notice about the source's own
   *  connection), or undefined. `ctx` acts on the source's own settings and triggers. */
  handshake?(headers: Headers, body: Buffer, ctx: PushContext): { status: number; body: Json } | undefined | Promise<{ status: number; body: Json } | undefined>;
  /** The events the request holds, none or more: none is a request this source takes nothing from (answered 200, and
   *  said). `ignored`: a request `source` does not take (its trigger's own filter), with why: answered 200
   *  `{ok: "ignored"}`, and said. */
  parse(headers: Headers, body: Buffer, source?: Source): PushEvent[] | PushIgnored;
};
/** A verified request its trigger's source does not take: why (`ignored`), the event it was, when it names one, and its
 *  key (`key`, as its event would be keyed), which its trigger keeps for its day: the same request sent again under
 *  another label (an unsigned event header) is then a duplicate, never a firing. */
export type PushIgnored = { ignored: string; event?: string; key?: string };
/** What a source's handshake may do beyond its answer: read its own settings (its request's scope: the server's, or its
 *  trigger's), hand a notice about the source's own connection (an App's installation) to the server's code for that
 *  source, which checks it and answers it, and say. */
export type PushContext = {
  setting(field: string): string | undefined;
  notice(event: string, body: unknown): Promise<{ status: number; body: Json } | undefined>;
  say(fields: Record<string, string>): void;
};
/** One event a pushed source delivers: `key`, its id (the sender's, which a retry repeats: one event delivered twice is
 *  one firing); `text`, what its run is given; `scope`, for a source whose settings are the server's, where it happened
 *  (a channel, a repository), matched to each trigger's scopeOf; `attrs`, what else the source says of it; `event` and
 *  `body`, its event's name and its parsed body, which a source's takes reads (never kept). */
export type PushEvent = { key: string; text: string; scope?: string; attrs?: Record<string, string>; event?: string; body?: unknown };
/** A closed object's JSON Schema: its fields, each by its own schema, and the ones it always holds. */
export type ObjectSchema = { type: "object"; additionalProperties: false; required: string[]; properties: Record<string, Json> };

/** A closed object schema: every field in `required` is, and `optional`'s may be. */
export const closedSchema = (required: Record<string, Json>, optional: Record<string, Json> = {}): ObjectSchema => ({ type: "object", additionalProperties: false, required: Object.keys(required), properties: { ...required, ...optional } });

/** `value`'s fields past `allowed`, as issues under `source`. */
export const unknownSourceFields = (value: Json, allowed: readonly string[]): InputIssue[] => unknownFields(value, allowed).map((i) => ({ ...i, field: `source.${i.field}` }));

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/i;
/** An RFC 3339 date-time with its offset, as an instant; undefined for one that names no real time (month 13, Feb 30,
 *  25 o'clock, an offset past 23:59), which Date.parse would refuse or roll over. */
export function instantOf(text: unknown): number | undefined {
  const parts = typeof text === "string" ? RFC3339.exec(text) : null;
  if (!parts) return undefined;
  const [y, mo, d, h, mi, s, , , oh = "0", om = "0"] = parts.slice(1).map((p) => p ?? "0").map(String);
  const days = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > days || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59 || Number(oh) > 23 || Number(om) > 59) return undefined;
  const at = Date.parse(text as string);
  return Number.isFinite(at) ? at : undefined;
}
/** RFC 3339 in UTC, to the second: the form a schedule's key is made of. */
export const second = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** Whether this server's ICU knows `zone` (an IANA zone). */
export const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
