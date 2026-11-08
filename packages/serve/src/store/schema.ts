// The store's one schema, version 1 (design 2.1). Nothing migrates into it: the rewrite replaces the old stores. Times are
// ISO 8601 UTC text, JSON is text, money is real US dollars. Sealed columns hold ciphertext only (sealed with the server's
// key outside the store); the store never sees a secret in the clear.
//
// STORE_DDL is the control plane and the runs: agents, revisions, runs (state, the claim's epoch, runner and claimed_until,
// cost, metrics, summary), commands, triggers, settings, sealed keys, learning state, the MCP registry and each run's MCP
// pin. PI_DDL is pi-durable's journal tables, keyed by run_id (store/journal, module A2): one schema for every run's
// journal, so a query joins runs and their journals. SqliteStore runs both in one write transaction at open.

export const SCHEMA_VERSION = 1;

export const STORE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS store_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    flushes INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    current_revision TEXT,
    created_at TEXT NOT NULL,
    archived_at TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    kind TEXT NOT NULL CHECK (kind IN ('agentic', 'workflow')),
    body TEXT NOT NULL CHECK (json_valid(body)),
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS revisions_by_agent ON revisions (agent_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    revision_id TEXT NOT NULL REFERENCES revisions (id),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'parked', 'ended', 'stopped', 'failed')),
    epoch INTEGER NOT NULL DEFAULT 0,
    runner TEXT,
    claimed_until TEXT,
    cost_usd REAL,
    metrics TEXT CHECK (metrics IS NULL OR json_valid(metrics)),
    summary TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS runs_by_agent ON runs (agent_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS runs_by_revision ON runs (revision_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS runs_claimable ON runs (state, claimed_until)`,
  `CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    kind TEXT NOT NULL,
    body TEXT NOT NULL CHECK (json_valid(body)),
    created_at TEXT NOT NULL,
    taken_at TEXT
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS commands_by_run ON commands (run_id, id)`,
  `CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    body TEXT NOT NULL CHECK (json_valid(body)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS triggers_by_agent ON triggers (agent_id)`,
  `CREATE TABLE IF NOT EXISTS trigger_firings (
    trigger_id TEXT NOT NULL REFERENCES triggers (id),
    firing_key TEXT NOT NULL,
    run_id TEXT REFERENCES runs (id),
    fired_at TEXT NOT NULL,
    PRIMARY KEY (trigger_id, firing_key)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS sealed_keys (
    name TEXT PRIMARY KEY,
    sealed BLOB NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS learning (
    agent_id TEXT NOT NULL REFERENCES agents (id),
    key TEXT NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, key)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    body TEXT NOT NULL CHECK (json_valid(body)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS mcp_tools (
    server_id TEXT NOT NULL REFERENCES mcp_servers (id),
    name TEXT NOT NULL,
    body TEXT NOT NULL CHECK (json_valid(body)),
    listed_at TEXT NOT NULL,
    PRIMARY KEY (server_id, name)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS mcp_prices (
    server_id TEXT NOT NULL REFERENCES mcp_servers (id),
    tool TEXT NOT NULL,
    usd REAL NOT NULL CHECK (usd >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (server_id, tool)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS mcp_credentials (
    server_id TEXT PRIMARY KEY REFERENCES mcp_servers (id),
    kind TEXT NOT NULL CHECK (kind IN ('header', 'oauth')),
    sealed BLOB NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS mcp_pins (
    run_id TEXT PRIMARY KEY REFERENCES runs (id),
    body TEXT NOT NULL CHECK (json_valid(body)),
    pinned_at TEXT NOT NULL
  ) STRICT`,
];

/** pi-durable's journal tables, every one keyed by (run_id, …) with run_id leading its indexes: store/journal's RunStorage
 *  (module A2) writes them. The names are agreed with A2; their columns are A2's. */
export const PI_TABLES = ["pi_record_ids", "pi_metadata", "pi_conversations", "pi_entries", "pi_tasks", "pi_submissions", "pi_documents", "pi_document_revisions"] as const;
export const PI_DDL: readonly string[] = [];

/** Everything the store's open runs, in order. */
export const DDL: readonly string[] = [...STORE_DDL, ...PI_DDL];
