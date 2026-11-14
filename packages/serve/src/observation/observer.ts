/** Hosted CLI observation protocol. A connector's receipts, session views and counters commit in one CAS.
 * Observation never launches a run, imports credentials, creates a runnable definition or enables learning. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../store/store.js";
import { NATIVE_OBSERVATION_HARNESSES, nativeObservationProtocol, type NativeObservationHarness } from "../native/runtimes.js";

const PREFIX = "observation.connector.";
const DAY = 86_400_000;
const OFFLINE = 120_000;
const MAX_RECEIPTS = 100_000;
const RECEIPT_WINDOW = 7 * DAY;
const SESSION_WINDOW = 90 * DAY;
const MAX_SESSIONS = 1_000;
const MAX_CONNECTORS = 100;
const COUNTS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
] as const;
type Harness = NativeObservationHarness;
type Activity =
  | "working"
  | "idle"
  | "waiting_input"
  | "finished"
  | "failed"
  | "stopped"
  | "unknown";
type Selection = {
  source_id: string;
  harness: Harness;
  mode: "session" | "project" | "harness";
  external_session_id: string | null;
  include_future_sessions: boolean;
};
type Usage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};
type Event = {
  event_id: string;
  source_id: string;
  external_session_id: string;
  sequence: number;
  type: "session_observed";
  occurred_at: string;
  metadata: { harness: Harness; activity: Activity };
  source_time?: string;
  initial_only?: boolean;
  usage?: Usage;
};
type Session = {
  id: string;
  source_id: string;
  external_session_id: string;
  harness: Harness;
  activity: Activity;
  sequence: number;
  source_time?: string;
  ingestion_epoch?: number;
  occurred_at: string;
  received_at: string;
  created_at: string;
  updated_at: string;
  usage_by_day: Record<string, Record<string, Usage>>;
};
type Receipt = { hash: string; occurred_at: string };
type Connector = {
  id: string;
  workspace_id: "local";
  installation_id: string;
  operation_id: string;
  display_name: string;
  cli_version: string;
  adapters: unknown[];
  ingestion_mode: "polling" | "otlp";
  ingestion_epoch?: number;
  selections: Selection[];
  selections_revision: number;
  source_bindings: Record<string, string>;
  credential_hash: string;
  credential_expires_at: string;
  state: "active" | "revoked";
  created_at: string;
  updated_at: string;
  last_heartbeat_at: string | null;
  dropped_events: number;
  window: number;
  count: number;
  sessions: Record<string, Session>;
  receipts: Record<string, Receipt>;
  receipt_floor: number;
};
export class ObservationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
function refuse(
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): never {
  throw new ObservationError(status, code, details);
}
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map(
            (k) =>
              `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
          )
          .join(",")}}`
      : JSON.stringify(v);
const fingerprint = (v: unknown) => hash(canonical(v));
const obj = (v: unknown): Record<string, any> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : refuse(422, "connector_invalid");
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).some((k) => !keys.includes(k)))
    refuse(422, "connector_invalid");
};
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const harness = (v: unknown): v is Harness => nativeObservationProtocol(v) !== undefined;
const safeInt = (v: unknown, min = 0): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const activities = new Set([
  "unknown",
  "working",
  "idle",
  "waiting_input",
  "finished",
  "failed",
  "stopped",
]);
const timestamp = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) &&
  Number.isFinite(Date.parse(v));
const key = (connectorId: string) => PREFIX + connectorId;
const empty = () => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0 as number | null,
  cache_write_tokens: 0 as number | null,
  total_tokens: 0,
  cache_hit_rate: null as number | null,
  overflow: false,
});
const unavailable = () => ({ ...empty(), cache_read_tokens: null, cache_write_tokens: null });
function plus(total: ReturnType<typeof empty>, usage: Usage, exact = true) {
  total.input_tokens += usage.input_tokens;
  total.output_tokens += usage.output_tokens;
  total.total_tokens = total.input_tokens + total.output_tokens;
  for (const k of ["cache_read_tokens", "cache_write_tokens"] as const)
    total[k] =
      total[k] === null || usage[k] === undefined ? null : total[k] + usage[k]!;
  total.cache_hit_rate =
    total.input_tokens > 0 && total.cache_read_tokens !== null
      ? total.cache_read_tokens / total.input_tokens
      : null;
  if (!Number.isSafeInteger(total.total_tokens)) {
    if (exact) refuse(409, "connector_token_total_limit");
    total.overflow = true;
    total.input_tokens = Math.min(total.input_tokens, Number.MAX_SAFE_INTEGER);
    total.output_tokens = Math.min(
      total.output_tokens,
      Number.MAX_SAFE_INTEGER,
    );
    total.total_tokens = Number.MAX_SAFE_INTEGER;
    for (const k of ["cache_read_tokens", "cache_write_tokens"] as const)
      if (total[k] !== null)
        total[k] = Math.min(total[k]!, Number.MAX_SAFE_INTEGER);
    total.cache_hit_rate = null;
  }
}
function selections(input: unknown): Selection[] {
  if (!Array.isArray(input) || input.length > 1000)
    refuse(422, "connector_invalid");
  const seen = new Set<string>();
  return input.map((v) => {
    const s = obj(v);
    exact(s, [
      "source_id",
      "harness",
      "mode",
      "external_session_id",
      "include_future_sessions",
    ]);
    if (
      !id(s.source_id) ||
      seen.has(s.source_id) ||
      !harness(s.harness) ||
      !["session", "project", "harness"].includes(s.mode) ||
      typeof s.include_future_sessions !== "boolean"
    )
      refuse(422, "connector_invalid");
    seen.add(s.source_id);
    if (
      s.mode === "session"
        ? !id(s.external_session_id) || s.include_future_sessions
        : (s.external_session_id !== undefined &&
            s.external_session_id !== null) ||
          !s.include_future_sessions
    )
      refuse(422, "connector_invalid");
    return {
      ...s,
      external_session_id: s.external_session_id ?? null,
    } as Selection;
  });
}
function checkMode(
  row: Pick<Connector, "ingestion_mode" | "adapters">,
  sources: Selection[],
) {
  const supported = new Set(row.adapters.map((v) => obj(v).harness));
  if (sources.some((s) => !supported.has(s.harness)))
    refuse(403, "connector_source_denied");
  if (
    row.ingestion_mode === "otlp" &&
    (sources.some((s) => s.mode !== "harness") ||
      new Set(sources.map((s) => s.harness)).size !== sources.length)
  )
    refuse(422, "connector_invalid");
}
export const observationCapabilities = () => ({
  version: 1,
  ingestion_modes: ["polling", "otlp"],
  supported_harnesses: [...NATIVE_OBSERVATION_HARNESSES],
  logs_formats: ["json"],
  logs_endpoint_template:
    "/api/v2/control/connectors/{connector_id}/otel/v1/logs",
  selections_revision_header: "X-AgentRun-Selections-Revision",
  max_log_records: 100,
  max_payload_bytes: 65536,
  token_usage: {
    supported_harnesses: [...NATIVE_OBSERVATION_HARNESSES],
    model_attribute: "agentrun.model",
    count_attributes: COUNTS.map((k) => "agentrun." + k),
    input_includes_cache: true,
  },
  privacy: {
    metadata_only: true,
    session_id_attribute: "agentrun.session_id",
    session_id_format: "sha256",
    raw_session_ids: false,
  },
});

export class Observations {
  constructor(
    readonly store: Store,
    readonly now: () => number = Date.now,
  ) {}
  private stamp() {
    return new Date(this.now()).toISOString();
  }
  private async rows() {
    return (await this.store.settings.all({ prefix: PREFIX }))
      .filter((r) => r.key.startsWith(PREFIX))
      .map((r) => r.value as Connector);
  }
  private async row(connectorId: string) {
    const r = (await this.store.settings.get(key(connectorId))) as
      | Connector
      | undefined;
    if (!r) refuse(404, "connector_not_found");
    return r;
  }
  private authorize(row: Connector, credential: string) {
    if (
      row.state !== "active" ||
      Date.parse(row.credential_expires_at) <= this.now() ||
      !credential.startsWith("arc_") ||
      !timingSafeEqual(
        Buffer.from(hash(credential)),
        Buffer.from(row.credential_hash),
      )
    )
      refuse(401, "connector_unauthorized");
  }
  async authenticate(connectorId: string, credential: string) {
    const r = (await this.store.settings.get(key(connectorId))) as
      | Connector
      | undefined;
    if (!r) refuse(401, "connector_unauthorized");
    this.authorize(r, credential);
  }
  private async change<T>(
    connectorId: string,
    edit: (row: Connector) => T,
    credential?: string,
  ): Promise<T> {
    for (let tries = 0; tries < 30; tries++) {
      const previous = await this.row(connectorId);
      if (credential !== undefined) this.authorize(previous, credential);
      const next = structuredClone(previous);
      const answer = edit(next);
      next.updated_at = this.stamp();
      if (await this.store.settings.replaceIf(key(connectorId), previous, next))
        return answer;
    }
    return refuse(503, "connector_busy");
  }
  private summary(row: Connector) {
    return {
      id: row.id,
      workspace_id: "local",
      kind: "connector",
      state: row.state,
      display_name: row.display_name,
      owner_user_id: "owner",
      cli_version: row.cli_version,
      adapters: row.adapters,
      ingestion_mode: row.ingestion_mode,
      selections: row.selections,
      selections_revision: row.selections_revision,
      last_heartbeat_at: row.last_heartbeat_at,
      dropped_events: row.dropped_events,
      created_at: row.created_at,
      updated_at: row.updated_at,
      can_manage: true,
      receipt_count: Object.keys(row.receipts).length,
      receipt_capacity: MAX_RECEIPTS,
      storage_full: Object.keys(row.receipts).length >= MAX_RECEIPTS,
      connection_state:
        row.state === "revoked"
          ? "disconnected"
          : Date.parse(row.credential_expires_at) <= this.now()
            ? "offline"
            : row.last_heartbeat_at &&
                Date.parse(row.last_heartbeat_at) + OFFLINE > this.now()
              ? "online"
              : "offline",
    };
  }
  async register(input: unknown) {
    const b = obj(input);
    exact(b, [
      "workspace_id",
      "installation_id",
      "operation_id",
      "display_name",
      "cli_version",
      "adapters",
      "selections",
      "ingestion_mode",
    ]);
    if (b.workspace_id !== "local") refuse(403, "workspace_not_authorized");
    if (
      !uuid(b.installation_id) ||
      !uuid(b.operation_id) ||
      typeof b.display_name !== "string" ||
      !/^[^/\\\x00-\x1f\x7f]{1,80}$/.test(b.display_name) ||
      typeof b.cli_version !== "string" ||
      !/^[A-Za-z0-9_.+\-]{1,64}$/.test(b.cli_version) ||
      !Array.isArray(b.adapters) ||
      b.adapters.length < 1 ||
      b.adapters.length > 2 ||
      !["polling", "otlp"].includes(b.ingestion_mode ?? "polling")
    )
      refuse(422, "connector_invalid");
    const adapters: Record<string, any>[] = b.adapters.map((v: unknown) => {
      const a = obj(v);
      exact(a, ["harness", "adapter_version", "activity"]);
      if (
        !harness(a.harness) ||
        typeof a.adapter_version !== "string" ||
        !/^[A-Za-z0-9_.+\-]{1,64}$/.test(a.adapter_version) ||
        !["unknown", "lifecycle"].includes(a.activity)
      )
        refuse(422, "connector_invalid");
      return a;
    });
    if (new Set(adapters.map((a) => a.harness)).size !== adapters.length)
      refuse(422, "connector_invalid");
    const selected = selections(b.selections);
    if (!selected.length) refuse(422, "connector_invalid");
    checkMode(
      { adapters, ingestion_mode: b.ingestion_mode ?? "polling" },
      selected,
    );
    // Installation id chooses one durable connector; registration retries rotate via the owner-only endpoint.
    const connectorId = "oc_" + hash(b.installation_id).slice(0, 40);
    const prior = await this.store.settings.get(key(connectorId));
    const credential = "arc_" + randomBytes(48).toString("base64url");
    if (prior) {
      // Re-enrollment is an owner grant. A revoked connector can adopt the newly approved
      // mode, but a concurrent active connection cannot be silently replaced. Keep its
      // receipts and history; fresh credentials and revision fence all previous uploads.
      return this.change(connectorId, (row) => {
        if (row.state !== "revoked")
          refuse(409, "connector_reauthentication_required", { connector_id: connectorId });
        for (const s of selected) {
          const f = fingerprint(s);
          if (Object.hasOwn(row.source_bindings, s.source_id) && row.source_bindings[s.source_id] !== f)
            refuse(409, "connector_source_rebound");
          Object.defineProperty(row.source_bindings, s.source_id, {
            value: f, enumerable: true, writable: true, configurable: true,
          });
        }
        if (Object.keys(row.source_bindings).length > 1000) refuse(422, "connector_source_limit");
        const mode = b.ingestion_mode ?? "polling";
        if (row.ingestion_mode !== mode) row.ingestion_epoch = (row.ingestion_epoch ?? 0) + 1;
        row.ingestion_mode = mode;
        row.adapters = adapters;
        row.selections = selected;
        row.selections_revision++;
        row.display_name = b.display_name;
        row.cli_version = b.cli_version;
        row.operation_id = b.operation_id;
        row.credential_hash = hash(credential);
        row.credential_expires_at = new Date(this.now() + 90 * DAY).toISOString();
        row.state = "active";
        row.last_heartbeat_at = null;
        return { connector: this.summary(row), credential, credential_expires_at: row.credential_expires_at };
      });
    }
    if ((await this.rows()).length >= MAX_CONNECTORS)
      refuse(429, "connector_capacity_exceeded");
    const row: Connector = {
      id: connectorId,
      workspace_id: "local",
      installation_id: b.installation_id,
      operation_id: b.operation_id,
      display_name: b.display_name,
      cli_version: b.cli_version,
      adapters,
      ingestion_mode: b.ingestion_mode ?? "polling",
      selections: selected,
      selections_revision: 1,
      source_bindings: Object.fromEntries(
        selected.map((s) => [s.source_id, fingerprint(s)]),
      ),
      credential_hash: hash(credential),
      credential_expires_at: new Date(this.now() + 90 * DAY).toISOString(),
      state: "active",
      created_at: this.stamp(),
      updated_at: this.stamp(),
      last_heartbeat_at: null,
      dropped_events: 0,
      window: 0,
      count: 0,
      sessions: {},
      receipts: {},
      receipt_floor: 0,
    };
    const saved = (await this.store.settings.putIfAbsent(
      key(connectorId),
      row,
    )) as Connector;
    if (saved.credential_hash !== row.credential_hash)
      refuse(409, "connector_reauthentication_required", {
        connector_id: connectorId,
      });
    return {
      connector: this.summary(saved),
      credential,
      credential_expires_at: saved.credential_expires_at,
    };
  }
  async rotate(connectorId: string) {
    const credential = "arc_" + randomBytes(48).toString("base64url");
    return this.change(connectorId, (row) => {
      row.state = "active";
      row.credential_hash = hash(credential);
      row.credential_expires_at = new Date(this.now() + 90 * DAY).toISOString();
      row.last_heartbeat_at = null;
      return {
        connector: this.summary(row),
        credential,
        credential_expires_at: row.credential_expires_at,
      };
    });
  }
  async revoke(connectorId: string) {
    return this.change(connectorId, (row) => {
      row.state = "revoked";
      return this.summary(row);
    });
  }
  async select(connectorId: string, input: unknown) {
    const b = obj(input);
    exact(b, ["selections_revision", "selections"]);
    const selected = selections(b.selections);
    return this.change(connectorId, (row) => {
      if (b.selections_revision !== row.selections_revision)
        refuse(409, "connector_selection_revision_mismatch", {
          selections_revision: row.selections_revision,
        });
      checkMode(row, selected);
      for (const s of selected) {
        const f = fingerprint(s);
        if (
          Object.hasOwn(row.source_bindings, s.source_id) &&
          row.source_bindings[s.source_id] !== f
        )
          refuse(409, "connector_source_rebound");
        Object.defineProperty(row.source_bindings, s.source_id, {
          value: f,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if (Object.keys(row.source_bindings).length > 1000)
        refuse(422, "connector_source_limit");
      if (canonical(row.selections) !== canonical(selected)) {
        row.selections = selected;
        row.selections_revision++;
      }
      return this.summary(row);
    });
  }
  async heartbeat(connectorId: string, credential: string, input: unknown) {
    const b = obj(input);
    exact(b, ["dropped_events"]);
    if (!safeInt(b.dropped_events ?? 0)) refuse(422, "connector_invalid");
    return this.change(
      connectorId,
      (row) => {
        row.last_heartbeat_at = this.stamp();
        row.dropped_events = Math.max(
          row.dropped_events,
          b.dropped_events ?? 0,
        );
        return {
          connector_id: row.id,
          selections_revision: row.selections_revision,
          selections: row.selections,
          heartbeat_interval_seconds: 30,
        };
      },
      credential,
    );
  }
  async events(connectorId: string, credential: string, input: unknown) {
    const b = obj(input);
    exact(b, ["selections_revision", "events"]);
    if (
      !safeInt(b.selections_revision, 1) ||
      !Array.isArray(b.events) ||
      b.events.length < 1 ||
      b.events.length > 100
    )
      refuse(422, "connector_invalid");
    const events: Event[] = b.events.map((v: unknown) => {
      const e = obj(v);
      exact(e, [
        "event_id",
        "source_id",
        "external_session_id",
        "sequence",
        "type",
        "occurred_at",
        "metadata",
      ]);
      const m = obj(e.metadata);
      exact(m, ["harness", "activity"]);
      if (
        !uuid(e.event_id) ||
        !id(e.source_id) ||
        !id(e.external_session_id) ||
        !safeInt(e.sequence, 1) ||
        e.type !== "session_observed" ||
        !timestamp(e.occurred_at) ||
        Date.parse(e.occurred_at) > this.now() + 300_000 ||
        !harness(m.harness) ||
        !activities.has(m.activity)
      )
        refuse(422, "connector_invalid");
      return e as Event;
    });
    return this.ingest(
      connectorId,
      credential,
      b.selections_revision,
      events,
      "polling",
    );
  }
  private async ingest(
    connectorId: string,
    credential: string,
    revision: number,
    events: Event[],
    mode: "polling" | "otlp",
  ) {
    return this.change(
      connectorId,
      (row) => {
        if (row.ingestion_mode !== mode)
          refuse(409, "connector_ingestion_mode_mismatch");
        if (row.selections_revision !== revision)
          refuse(409, "connector_selection_revision_mismatch", {
            selections_revision: row.selections_revision,
          });
        pruneConnector(row, this.now(), true);
        const window = Math.floor(this.now() / 60_000);
        if (row.window !== window) {
          row.window = window;
          row.count = 0;
        }
        let receiptCount = Object.keys(row.receipts).length;
        for (const e of events) {
          const source = row.selections.find(
            (s) =>
              s.source_id === e.source_id && s.harness === e.metadata.harness,
          );
          if (
            !source ||
            (source.mode === "session" &&
              source.external_session_id !== e.external_session_id)
          )
            refuse(403, "connector_source_denied");
          if (Date.parse(e.occurred_at) < row.receipt_floor) continue;
          const request = fingerprint(e),
            prior = row.receipts[e.event_id];
          if (prior) {
            if (prior.hash !== request) refuse(409, "idempotency_conflict");
            continue;
          }
          if (row.count >= 2000) refuse(429, "connector_rate_limited");
          if (receiptCount >= MAX_RECEIPTS)
            refuse(429, "connector_receipt_capacity_exceeded", {
              retry_after_seconds: Math.max(
                1,
                Math.ceil(
                  (Object.values(row.receipts).reduce(
                    (earliest, r) =>
                      Math.min(earliest, Date.parse(r.occurred_at)),
                    Infinity,
                  ) +
                    RECEIPT_WINDOW -
                    this.now()) /
                    1000,
                ),
              ),
            });
          const sessionId =
              "os_" +
              hash(
                [connectorId, e.metadata.harness, e.external_session_id].join(
                  ":",
                ),
              ).slice(0, 40),
            old = row.sessions[sessionId];
          if (!old && Object.keys(row.sessions).length >= MAX_SESSIONS)
            refuse(429, "connector_session_capacity_exceeded");
          const at = this.stamp();
          row.receipts[e.event_id] = {
            hash: request,
            occurred_at: e.occurred_at,
          };
          receiptCount++;
          row.count++;
          const newer = (old?.ingestion_epoch ?? 0) !== (row.ingestion_epoch ?? 0) || (
            mode === "otlp"
              ? BigInt(e.source_time!) >
                BigInt(old?.source_time ?? String((old?.sequence ?? 0) * 1000))
              : e.sequence > (old?.sequence ?? 0));
          if (!old || (!e.initial_only && newer))
            row.sessions[sessionId] = {
              id: sessionId,
              source_id: e.source_id,
              external_session_id: e.external_session_id,
              harness: e.metadata.harness,
              activity: e.metadata.activity,
              sequence: e.sequence,
              ingestion_epoch: row.ingestion_epoch ?? 0,
              ...(e.source_time ? { source_time: e.source_time } : {}),
              occurred_at: e.occurred_at,
              received_at: at,
              created_at: old?.created_at ?? at,
              updated_at: at,
              usage_by_day: old?.usage_by_day ?? {},
            };
          if (e.usage) {
            const session = row.sessions[sessionId]!;
            const date = at.slice(0, 10);
            const day = (session.usage_by_day[date] ??= {});
            const previous = Object.hasOwn(day, e.usage.model)
              ? day[e.usage.model]
              : undefined;
            const next = empty();
            if (previous) plus(next, previous);
            plus(next, e.usage);
            day[e.usage.model] = {
              model: e.usage.model,
              input_tokens: next.input_tokens,
              output_tokens: next.output_tokens,
              ...(next.cache_read_tokens === null
                ? {}
                : { cache_read_tokens: next.cache_read_tokens }),
              ...(next.cache_write_tokens === null
                ? {}
                : { cache_write_tokens: next.cache_write_tokens }),
            };
            // Reject before committing if this connector's retained aggregates exceed exact integer accounting.
            const total = empty();
            for (const saved of Object.values(row.sessions))
              for (const daily of Object.values(saved.usage_by_day))
                for (const u of Object.values(daily)) plus(total, u);
          }
        }
        if (mode === "otlp" && events.length)
          row.last_heartbeat_at = this.stamp();
        return { accepted_event_ids: events.map((e) => e.event_id) };
      },
      credential,
    );
  }
  async otlp(
    connectorId: string,
    credential: string,
    input: unknown,
    revision: number,
  ) {
    if (!safeInt(revision, 1)) refuse(400, "connector_otlp_invalid");
    const b = obj(input),
      resources = b.resourceLogs ?? b.resource_logs ?? [];
    if (!Array.isArray(resources) || resources.length > 100)
      refuse(400, "connector_otlp_invalid");
    const events: Event[] = [];
    let rejected = 0,
      total = 0;
    const current = await this.row(connectorId);
    this.authorize(current, credential);
    if (current.ingestion_mode !== "otlp")
      refuse(409, "connector_ingestion_mode_mismatch");
    if (current.selections_revision !== revision)
      refuse(409, "connector_selection_revision_mismatch", {
        selections_revision: current.selections_revision,
      });
    for (const item of resources) {
      const resource = obj(item),
        attrs = attributes(obj(resource.resource ?? {}).attributes ?? []);
      const h = stringValue(attrs["agentrun.harness"]),
        source = stringValue(attrs["agentrun.source_id"]);
      if (
        !current.selections.some(
          (s) =>
            s.source_id === source &&
            s.harness === h &&
            s.mode === "harness" &&
            s.include_future_sessions,
        )
      )
        refuse(403, "connector_source_denied");
      const scopes = resource.scopeLogs ?? resource.scope_logs ?? [];
      if (!Array.isArray(scopes) || scopes.length > 100)
        refuse(400, "connector_otlp_invalid");
      for (const value of scopes) {
        const scope = obj(value),
          logs = scope.logRecords ?? scope.log_records ?? [];
        if (!Array.isArray(logs) || (total += logs.length) > 100)
          refuse(413, "request_too_large");
        for (const record of logs) {
          const log = obj(record),
            a = attributes(log.attributes ?? []),
            name = stringValue(a["event.name"]),
            session = stringValue(a["agentrun.session_id"]);
          const activity = nativeActivity(h, name),
            rawStamp = log.timeUnixNano ?? log.time_unix_nano;
          let nanos: bigint;
          try {
            if (typeof rawStamp !== "string" || !/^\d{1,20}$/.test(rawStamp))
              throw Error();
            nanos = BigInt(rawStamp);
          } catch {
            rejected++;
            continue;
          }
          if (
            !activity ||
            !session ||
            !/^[0-9a-f]{64}$/.test(session) ||
            nanos / 1_000_000n <
              BigInt(
                Math.max(
                  current.receipt_floor ?? 0,
                  this.now() - RECEIPT_WINDOW,
                ),
              ) ||
            nanos / 1000n < 1n ||
            nanos / 1000n > BigInt(Number.MAX_SAFE_INTEGER) ||
            nanos > BigInt(this.now() + 300_000) * 1_000_000n
          ) {
            rejected++;
            continue;
          }
          let usage: Usage | undefined;
          try {
            usage = nativeUsage(h!, name!, a);
          } catch {
            rejected++;
            continue;
          }
          const event: Event = {
            event_id: "",
            source_id: source!,
            external_session_id: session,
            sequence: Number(nanos / 1000n),
            type: "session_observed",
            occurred_at: new Date(Number(nanos / 1_000_000n)).toISOString(),
            metadata: { harness: h as Harness, activity },
            source_time: nanos.toString(),
            ...(usage ? { usage } : {}),
            ...(name === "codex.conversation_starts"
              ? { initial_only: true }
              : {}),
          };
          // Deterministic id comes solely from normalized allowlisted metadata, never discarded prompt/tool payloads.
          event.event_id = hash(canonical({ name, ...event }));
          events.push(event);
        }
      }
    }
    // Empty/fully rejected payload still checks the latest scoped credential, mode and selection revision under CAS.
    await this.ingest(connectorId, credential, revision, events, "otlp");
    return rejected
      ? {
          partialSuccess: {
            rejectedLogRecords: String(rejected),
            errorMessage:
              "Some records were not valid selected session metadata.",
          },
        }
      : {};
  }
  /** Remove expired persisted metadata even when a source is idle or revoked. CAS retries start from the
   * newest connector, so retention never restores a revoked credential or overwrites concurrent ingestion. */
  async sweep() {
    let changed = 0;
    for (const scanned of await this.rows()) {
      let settled = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const previous = attempt === 0 ? scanned : await this.row(scanned.id);
        const next = structuredClone(previous);
        if (!pruneConnector(next, this.now())) {
          settled = true;
          break;
        }
        next.updated_at = this.stamp();
        if (
          await this.store.settings.replaceIf(key(scanned.id), previous, next)
        ) {
          changed++;
          settled = true;
          break;
        }
      }
      if (!settled) refuse(503, "connector_busy");
    }
    return { pruned_connectors: changed };
  }
  async list() {
    return {
      items: (await this.rows()).map((r) => this.summary(r)),
      next_cursor: null,
    };
  }
  async snapshot(days = 30, sessionId?: string) {
    if (!Number.isInteger(days) || days < 1 || days > 31)
      refuse(422, "token_usage_period_invalid");
    const rows = await this.rows(),
      sessions: any[] = [],
      usage = empty(),
      models = new Map<string, ReturnType<typeof empty>>(),
      daily = new Map<string, number>();
    let reports = 0;
    const start = Date.parse(this.stamp().slice(0, 10)) - (days - 1) * DAY;
    for (const row of rows) {
      const summaries = new Map<
        string,
        { usage: ReturnType<typeof empty>; models: Set<string> }
      >();
      for (const session of Object.values(row.sessions)) {
        if (sessionId && session.id !== sessionId) continue;
        const own = { usage: empty(), models: new Set<string>() };
        for (const [date, dailyUsage] of Object.entries(session.usage_by_day))
          for (const u of Object.values(dailyUsage)) {
            if (Date.parse(date) + DAY < this.now() - SESSION_WINDOW) continue;
            plus(own.usage, u);
            own.models.add(u.model);
            if (Date.parse(date) + DAY <= start) continue;
            reports++;
            plus(usage, u, false);
            const model = models.get(u.model) ?? empty();
            plus(model, u, false);
            models.set(u.model, model);
            daily.set(
              date,
              Math.min(
                Number.MAX_SAFE_INTEGER,
                (daily.get(date) ?? 0) + u.input_tokens + u.output_tokens,
              ),
            );
          }
        if (own.models.size) summaries.set(session.id, own);
      }
      const connector = this.summary(row);
      for (const s of Object.values(row.sessions)) {
        if (sessionId && s.id !== sessionId) continue;
        if (Date.parse(s.received_at) < this.now() - SESSION_WINDOW) continue;
        const active =
          row.state === "active" &&
          row.selections.some(
            (v) =>
              v.source_id === s.source_id &&
              v.harness === s.harness &&
              (v.mode !== "session" ||
                v.external_session_id === s.external_session_id),
          );
        const stale =
          Math.min(Date.parse(s.received_at), Date.parse(s.occurred_at)) +
            OFFLINE <=
          this.now();
        const terminal = ["finished", "failed", "stopped"].includes(s.activity);
        const summary = summaries.get(s.id);
        const { usage_by_day, ingestion_epoch, ...shown } = s;
        sessions.push({
          ...shown,
          connector_id: row.id,
          workspace_id: "local",
          kind: "connected_session",
          state: "active",
          display_name: `${row.display_name} · ${s.harness === "claude" ? "Claude Code" : "Codex"}`,
          reported_activity: s.activity,
          activity: terminal
            ? s.activity
            : stale || !active || connector.connection_state !== "online"
              ? "unknown"
              : s.activity,
          connection_state: connector.connection_state,
          selection_active: active,
          observation_only: true,
          models: [...(summary?.models ?? [])],
          usage: {
            ...(summary?.usage ?? unavailable()),
            status: summary ? "reported" : "unavailable",
          },
        });
      }
    }
    sessions.sort((a, b) => b.received_at.localeCompare(a.received_at));
    return {
      connectors: rows.map((r) => this.summary(r)),
      sessions,
      usage: {
        ...readableTotals(reports ? usage : unavailable()),
        status: reports && !usage.overflow ? "partial" : "unavailable",
        models: [...models].map(([model, counts]) => ({
          model,
          ...readableTotals(counts),
        })),
        daily: [...daily].sort().map(([date, total_tokens]) => ({
          date,
          total_tokens: usage.overflow ? null : total_tokens,
        })),
        coverage: "reported_tokens_only",
      },
      limits: {
        max_receipts_per_connector: MAX_RECEIPTS,
        max_sessions_per_connector: MAX_SESSIONS,
        receipt_retention: "7 days; older event timestamps are refused",
        receipt_window_seconds: RECEIPT_WINDOW / 1000,
        session_retention_days: 90,
        usage_retention_days: 90,
      },
    };
  }
}
function attributes(input: unknown): Record<string, Record<string, any>> {
  if (!Array.isArray(input) || input.length > 128)
    refuse(400, "connector_otlp_invalid");
  const result: Record<string, Record<string, any>> = Object.create(null);
  for (const item of input) {
    const a = obj(item);
    if (typeof a.key !== "string" || Object.hasOwn(result, a.key))
      refuse(400, "connector_otlp_invalid");
    result[a.key] = obj(a.value ?? {});
  }
  return result;
}
const stringValue = (v: Record<string, any> | undefined): string | undefined =>
  typeof (v?.stringValue ?? v?.string_value) === "string"
    ? (v?.stringValue ?? v?.string_value)
    : undefined;
function nativeActivity(
  h: string | undefined,
  name: string | undefined,
): Activity | undefined {
  if (!name) return;
  if (name.startsWith("agentrun.session.")) {
    const state = name.slice("agentrun.session.".length);
    return activities.has(state) ? (state as Activity) : undefined;
  }
  const events = nativeObservationProtocol(h)?.activityEvents;
  return events && Object.hasOwn(events, name) ? events[name] : undefined;
}
function nativeUsage(
  h: string,
  name: string,
  a: Record<string, Record<string, any>>,
): Usage | undefined {
  const protocol = nativeObservationProtocol(h);
  if (!protocol?.usageEvents.includes(name)) return;
  if (
    !["agentrun.model", ...COUNTS.map((k) => "agentrun." + k)].some(
      (k) => a[k] !== undefined,
    )
  )
    return;
  const model = stringValue(a["agentrun.model"]);
  if (!model || !/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}$/.test(model))
    throw Error();
  const usage: Record<string, any> = { model };
  for (const k of COUNTS) {
    const v = a["agentrun." + k];
    if (!v) {
      if (protocol.requireCacheUsage || k === "input_tokens" || k === "output_tokens")
        throw Error();
      continue;
    }
    const raw = v.intValue ?? v.int_value;
    if (typeof raw !== "string" && typeof raw !== "number") throw Error();
    if (typeof raw === "string" && !/^\d+$/.test(raw)) throw Error();
    const n = Number(raw);
    if (!safeInt(n)) throw Error();
    usage[k] = n;
  }
  if (
    (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0) >
      usage.input_tokens ||
    !Number.isSafeInteger(usage.input_tokens + usage.output_tokens)
  )
    throw Error();
  return usage as Usage;
}

function readableTotals(total: ReturnType<typeof empty>) {
  return total.overflow
    ? {
        ...total,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
        total_tokens: null,
        cache_hit_rate: null,
      }
    : total;
}

/** The floor advances whenever metadata is removed, even if the wall clock subsequently moves backwards.
 * Keep usage that arrived after the last activity update until its own retention ends. Hidden stale activity
 * must not erase a newer, already accepted usage receipt. No-op sweeps leave the settings row untouched. */
function pruneConnector(
  row: Connector,
  now: number,
  advanceFloor = false,
): boolean {
  let changed = false;
  const floor = Math.max(row.receipt_floor ?? 0, now - RECEIPT_WINDOW);
  for (const [eventId, receipt] of Object.entries(row.receipts)) {
    if (Date.parse(receipt.occurred_at) < floor) {
      delete row.receipts[eventId];
      changed = true;
    }
  }
  for (const [sessionId, session] of Object.entries(row.sessions)) {
    for (const day of Object.keys(session.usage_by_day)) {
      if (Date.parse(day) + DAY < now - SESSION_WINDOW) {
        delete session.usage_by_day[day];
        changed = true;
      }
    }
    if (
      Date.parse(session.received_at) < now - SESSION_WINDOW &&
      Object.keys(session.usage_by_day).length === 0
    ) {
      delete row.sessions[sessionId];
      changed = true;
    }
  }
  if (changed || advanceFloor) row.receipt_floor = floor;
  return changed;
}

/** Start with one awaited sweep, then run one at a time. Stopping drains the last sweep before store close. */
export async function maintainObservations(
  observer: Observations,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
) {
  await observer.sweep();
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      pending = observer
        .sweep()
        .then(() => undefined)
        .catch((error) => {
          options.onError?.(error);
        })
        .finally(schedule);
    }, options.intervalMs ?? 60_000);
    timer.unref();
  };
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}
