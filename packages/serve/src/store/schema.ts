// The store's one schema, version 1 (design 2.1). Nothing migrates into it: the rewrite replaces the old stores. The server
// sets it up once at its start (a store_meta row holds the version); a runner refuses a version it does not know.
// Conventions: every time is INTEGER epoch milliseconds; JSON is TEXT checked by json_valid; money is REAL US dollars;
// sealed columns hold ciphertext only (sealed with the server's key outside the store), so the store never sees a secret
// in the clear. Foreign keys are on (the connection's pragma).
//
// STORE_DDL is the control plane and the runs: agents and revisions (with a template's package), runs (state, the claim's
// epoch, runner, claimed_until and wake_at, cost, metrics, summary), commands, idempotency, triggers (their scopes,
// firings, conversations and settings), the channel outbox and told ledger, the review ledger, settings, sealed keys,
// learning state, the MCP registry, pending MCP sign-ins and each run's MCP pin. PI_DDL is pi-durable's journal tables,
// keyed by run_id (store/journal): one schema for every run's journal, so a query joins runs and their journals.

export const SCHEMA_VERSION = 1;

const json = (column: string, nullable = false) => `${column} TEXT${nullable ? "" : " NOT NULL"} CHECK (${column} IS NULL OR json_valid(${column}))`;

export const STORE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS store_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    flushes INTEGER NOT NULL DEFAULT 0
  ) STRICT`,

  // Agents and their revisions. A revision made from a template keeps its package: {name, version (SemVer), source
  // builtin|git, ref, sha, parameters}.
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    current_revision TEXT,
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    kind TEXT NOT NULL CHECK (kind IN ('agentic', 'workflow')),
    ${json("body")},
    ${json("package", true)},
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS revisions_by_agent ON revisions (agent_id, created_at)`,

  // Runs: a parked run holds no claim (its runner flushed and released it); it is claimable again when a command row lands
  // or wake_at passes.
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    revision_id TEXT NOT NULL REFERENCES revisions (id),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'parked', 'ended', 'stopped', 'failed')),
    epoch INTEGER NOT NULL DEFAULT 0,
    runner TEXT,
    claimed_until INTEGER,
    wake_at INTEGER,
    backoff_until INTEGER,
    cost_usd REAL,
    ${json("metrics", true)},
    summary TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS runs_by_agent ON runs (agent_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS runs_by_revision ON runs (revision_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS runs_claimable ON runs (state, started_at)`,

  // Commands the server writes for a run, taken (or refused, with why) by its runner.
  `CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    kind TEXT NOT NULL,
    ${json("body")},
    created_at INTEGER NOT NULL,
    taken_at INTEGER,
    refused TEXT,
    tries INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS commands_by_run ON commands (run_id, id)`,
  `CREATE INDEX IF NOT EXISTS commands_untaken ON commands (run_id) WHERE taken_at IS NULL`,

  // An API call's answer kept under its idempotency key, per scope.
  `CREATE TABLE IF NOT EXISTS idempotency (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    ${json("response")},
    at INTEGER NOT NULL,
    PRIMARY KEY (scope, key)
  ) STRICT`,

  // Triggers (module E's), their scopes (rows only while enabled), firings, conversations and adapter settings.
  `CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    ${json("source")},
    ${json("target")},
    next_at INTEGER,
    last_run_id TEXT REFERENCES runs (id),
    catchup_window_s INTEGER,
    failures_in_a_row INTEGER NOT NULL DEFAULT 0,
    ${json("disabled", true)},
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (agent_id, name)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS triggers_due ON triggers (enabled, next_at)`,
  `CREATE TABLE IF NOT EXISTS trigger_scopes (
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    trigger_id TEXT NOT NULL REFERENCES triggers (id) ON DELETE CASCADE,
    PRIMARY KEY (kind, scope)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS trigger_firings (
    trigger_id TEXT NOT NULL REFERENCES triggers (id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    by TEXT,
    nominal_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('due', 'started', 'skipped', 'failed', 'missed')),
    at INTEGER NOT NULL,
    run_id TEXT REFERENCES runs (id),
    reason TEXT,
    ${json("error", true)},
    count INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER,
    notified INTEGER,
    catch_up INTEGER,
    paused INTEGER,
    payload TEXT,
    shown INTEGER,
    PRIMARY KEY (trigger_id, key)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS trigger_firings_retry ON trigger_firings (status, retry_at)`,
  `CREATE INDEX IF NOT EXISTS trigger_firings_recent ON trigger_firings (trigger_id, at DESC)`,
  `CREATE TABLE IF NOT EXISTS trigger_conversations (
    trigger_id TEXT NOT NULL REFERENCES triggers (id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    run_id TEXT REFERENCES runs (id),
    created_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    PRIMARY KEY (trigger_id, key)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS trigger_settings (
    adapter TEXT NOT NULL,
    scope TEXT NOT NULL,
    field TEXT NOT NULL,
    sealed TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (adapter, scope, field)
  ) STRICT`,

  // The channel outbox (a post a run's moment owes a channel) and the told ledger (what a channel was told of a run).
  `CREATE TABLE IF NOT EXISTS channel_posts (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    conversation TEXT,
    run_id TEXT REFERENCES runs (id),
    wait TEXT,
    moment TEXT NOT NULL,
    ${json("body")},
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL,
    claimed_until INTEGER,
    state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'dropped')),
    reason TEXT,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS channel_posts_due ON channel_posts (state, next_at)`,
  `CREATE INDEX IF NOT EXISTS channel_posts_by_run ON channel_posts (run_id)`,
  `CREATE TABLE IF NOT EXISTS channel_told (
    channel TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs (id),
    marker TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (channel, run_id, marker)
  ) STRICT`,

  // A code review's ledger, per head and firing.
  `CREATE TABLE IF NOT EXISTS review_ledger (
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    firing_key TEXT NOT NULL DEFAULT '',
    review_id TEXT,
    summary_comment_id TEXT,
    ${json("findings", true)},
    at INTEGER NOT NULL,
    PRIMARY KEY (repo, pr, head_sha, firing_key)
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    ${json("value")},
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS sealed_keys (
    name TEXT PRIMARY KEY,
    sealed BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS learning (
    agent_id TEXT NOT NULL REFERENCES agents (id),
    key TEXT NOT NULL,
    ${json("value")},
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, key)
  ) STRICT`,

  // The MCP registry: one row per saved server (its listed tools with each one's grantable and meta reason, the owner's
  // prices, and the credential, a bearer, headers or the OAuth token set and client, sealed). A sign-in in flight (10 min).
  // A run's pin: written once in its first claim's commit, never rewritten.
  `CREATE TABLE IF NOT EXISTS mcp_servers (
    name TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    auth TEXT NOT NULL,
    protocol TEXT,
    ${json("tools")},
    ${json("prices")},
    sealed BLOB,
    refresh_holder TEXT,
    refresh_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
    state TEXT PRIMARY KEY,
    server TEXT NOT NULL,
    verifier_sealed BLOB NOT NULL,
    cookie_binding TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS mcp_pins (
    run_id TEXT PRIMARY KEY REFERENCES runs (id),
    ${json("body")},
    pinned_at INTEGER NOT NULL
  ) STRICT`,

  // A running run's live view (the tool it runs now, its partial text): one row, outside the journal, overwritten in place
  // by its runner's tick and dropped at its end.
  `CREATE TABLE IF NOT EXISTS run_live (
    run_id TEXT PRIMARY KEY REFERENCES runs (id),
    ${json("state")},
    updated_at INTEGER NOT NULL
  ) STRICT`,
];

/** pi-durable's journal tables (its SqliteStorage schema, version 2, the `sleeping` task status included; MIT, see NOTICE),
 *  every one keyed by (run_id, …) with run_id leading its indexes, so one run's scans read only its rows and two runs never
 *  share an id, a seq or a document address. store/journal's RunStorage (module A2) writes them. */
export const PI_TABLE = {
  metadata: "pi_metadata",
  recordIds: "pi_record_ids",
  conversations: "pi_conversations",
  entries: "pi_entries",
  tasks: "pi_tasks",
  submissions: "pi_submissions",
  documents: "pi_documents",
  documentRevisions: "pi_document_revisions",
  commitWrites: "pi_commit_writes",
} as const;
export const PI_TABLES = ["pi_record_ids", "pi_metadata", "pi_conversations", "pi_entries", "pi_tasks", "pi_submissions", "pi_documents", "pi_document_revisions", "pi_commit_writes"] as const;

const P = PI_TABLE;
export const PI_DDL: readonly string[] = [
  // One row per run: the run's own id and seq namespaces. next_id is TEXT, as pi's: node:sqlite refuses INTEGER results
  // outside JavaScript's safe range.
  `CREATE TABLE IF NOT EXISTS ${P.metadata} (
    run_id TEXT PRIMARY KEY,
    next_id TEXT NOT NULL,
    next_seq INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS ${P.recordIds} (
    run_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document')),
    PRIMARY KEY (run_id, id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS ${P.conversations} (
    run_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    owner_conversation_id INTEGER,
    owner_task_id INTEGER,
    record TEXT NOT NULL CHECK (json_valid(record)),
    PRIMARY KEY (run_id, id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS pi_conversations_by_owner_conversation ON ${P.conversations} (run_id, owner_conversation_id, id)`,
  `CREATE INDEX IF NOT EXISTS pi_conversations_by_owner_task ON ${P.conversations} (run_id, owner_task_id, id)`,
  `CREATE TABLE IF NOT EXISTS ${P.entries} (
    run_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    head INTEGER,
    commit_seq INTEGER NOT NULL,
    record TEXT NOT NULL CHECK (json_valid(record)),
    PRIMARY KEY (run_id, id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS pi_entries_by_conversation ON ${P.entries} (run_id, conversation_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS pi_entry_heads_by_conversation ON ${P.entries} (run_id, conversation_id, id DESC) WHERE head IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ${P.tasks} (
    run_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
    abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
    background INTEGER NOT NULL CHECK (background IN (0, 1)),
    seq INTEGER NOT NULL,
    record TEXT NOT NULL CHECK (json_valid(record)),
    PRIMARY KEY (run_id, id)
  ) STRICT`,
  // seq: the commit that last wrote the row (the live view reads a run commit by commit, journal.commitsAfter).
  `CREATE INDEX IF NOT EXISTS pi_tasks_by_seq ON ${P.tasks} (run_id, seq)`,
  `CREATE INDEX IF NOT EXISTS pi_tasks_by_status ON ${P.tasks} (run_id, status, id)`,
  `CREATE INDEX IF NOT EXISTS pi_tasks_by_conversation ON ${P.tasks} (run_id, conversation_id, id)`,
  `CREATE INDEX IF NOT EXISTS pi_tasks_by_kind ON ${P.tasks} (run_id, kind, id)`,
  `CREATE INDEX IF NOT EXISTS pi_tasks_by_abort_requested ON ${P.tasks} (run_id, abort_requested, id)`,
  `CREATE INDEX IF NOT EXISTS pi_tasks_by_background ON ${P.tasks} (run_id, background, id)`,
  `CREATE TABLE IF NOT EXISTS ${P.submissions} (
    run_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    request_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
    seq INTEGER NOT NULL,
    record TEXT NOT NULL CHECK (json_valid(record)),
    PRIMARY KEY (run_id, id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS pi_submissions_by_seq ON ${P.submissions} (run_id, seq)`,
  `CREATE INDEX IF NOT EXISTS pi_submissions_by_request ON ${P.submissions} (run_id, conversation_id, request_id)`,
  `CREATE INDEX IF NOT EXISTS pi_submissions_by_conversation ON ${P.submissions} (run_id, conversation_id, id)`,
  `CREATE INDEX IF NOT EXISTS pi_submissions_by_status ON ${P.submissions} (run_id, status, id)`,
  `CREATE TABLE IF NOT EXISTS ${P.documents} (
    run_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    family INTEGER NOT NULL CHECK (family IN (0, 1)),
    key_value TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
    owner_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    retired_at INTEGER,
    record TEXT NOT NULL CHECK (json_valid(record)),
    PRIMARY KEY (run_id, id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS pi_documents_by_address
    ON ${P.documents} (run_id, kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
  `CREATE INDEX IF NOT EXISTS pi_documents_by_scope ON ${P.documents} (run_id, scope_kind, owner_id, id)`,
  `CREATE INDEX IF NOT EXISTS pi_documents_by_scope_kind ON ${P.documents} (run_id, scope_kind, owner_id, kind, id)`,
  `CREATE TABLE IF NOT EXISTS ${P.documentRevisions} (
    run_id TEXT NOT NULL,
    document_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
    version INTEGER NOT NULL,
    content TEXT NOT NULL CHECK (json_valid(content)),
    PRIMARY KEY (run_id, document_id, seq)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS pi_document_revisions_by_kind ON ${P.documentRevisions} (run_id, document_id, kind, seq DESC)`,
  // Each commit's own writes of the rows pi keeps only as they are now (a task, a submission, a document that keeps only
  // its latest value), as that commit wrote them, in its own transaction: journal.commitsAfter reads a run commit by
  // commit, so a replay equals the live view. Kept with the run (never pruned at its end), as its journal is.
  `CREATE TABLE IF NOT EXISTS ${P.commitWrites} (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('task', 'submission', 'document')),
    id INTEGER NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    PRIMARY KEY (run_id, seq, kind, id)
  ) STRICT`,
];

/** Everything the server's setup runs, in order. */
export const DDL: readonly string[] = [...STORE_DDL, ...PI_DDL];
