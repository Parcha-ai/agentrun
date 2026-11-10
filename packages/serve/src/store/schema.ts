// The store's one schema, version 5 (design 2.1). Nothing migrates into it: the rewrite replaces the old stores, and a store
// an older build made is refused as a version this build does not know. The server sets it up once at its start (a
// store_meta row holds the version); a runner refuses a version it does not know. Version 2 adds the computer ledger;
// version 3 numbers each save of a sign-in (sign_ins.save); version 4 stamps an MCP token's end (mcp_servers.token_until);
// version 5 maps an externally owned agent (agents.external_ref, revisions.external_version).
// Conventions: every time is INTEGER epoch milliseconds; JSON is TEXT checked by json_valid; money is REAL US dollars;
// sealed columns hold ciphertext only (sealed with the server's key outside the store), so the store never sees a secret
// in the clear. Foreign keys are on (the connection's pragma).
//
// STORE_DDL is the control plane and the runs: agents and revisions (with a template's package), runs (state, the claim's
// epoch, runner, claimed_until and wake_at, cost, metrics, summary), commands, idempotency, triggers (their scopes,
// firings, conversations and settings), the channel outbox and told ledger, the review ledger, settings, sealed keys,
// learning state, the MCP registry, pending MCP sign-ins, each run's MCP pin, and the computer ledger. PI_DDL is pi-durable's
// journal tables, keyed by run_id (store/journal): one schema for every run's journal, so a query joins runs and their
// journals.

export const SCHEMA_VERSION = 5;

/** One answer per approval of a run: a second approve or deny command naming the same approval is refused
 *  (StoreConstraint), so the first answer a person gives wins from the moment it is written, before the runner takes it
 *  (runs-over-store.ts approve). In STORE_DDL, and added at a server open to a store an earlier build of this version made. */
/** One unrefused answer per approval of a run: an answer the runner refused (its run could not resume) holds no place, so
 *  the person can answer again. */
export const COMMANDS_ONE_ANSWER = `CREATE UNIQUE INDEX IF NOT EXISTS commands_one_answer ON commands (run_id, json_extract(body, '$.approval')) WHERE kind IN ('approve', 'deny') AND refused IS NULL`;

const json = (column: string, nullable = false) => `${column} TEXT${nullable ? "" : " NOT NULL"} CHECK (${column} IS NULL OR json_valid(${column}))`;

export const STORE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS store_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    flushes INTEGER NOT NULL DEFAULT 0
  ) STRICT`,

  // Agents and their revisions. A revision made from a template keeps its package: {name, version (SemVer), source
  // builtin|git, ref, sha, parameters}.
  // `external_ref`: when the agent mirrors one owned by another system, its reference there, "<source>:<kind>:<id>" (e.g.
  // "grep:expert:42"), unique across agents. The agent is written on the first run that names it and is read-only from here;
  // null for an agent created here.
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    current_revision TEXT,
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    external_ref TEXT
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS agents_external ON agents (external_ref) WHERE external_ref IS NOT NULL`,
  // A revision's skills (the P4 fold of the old agent store's skill table): the revision's own skill files, a JSON object
  // keyed by the skill's path under `.agents/skills/` to its text. The body's `skills` map keeps the path to the text's
  // SHA-256 (so two revisions with the same files are one body, and a view can show each file's size), and this column
  // holds the texts themselves, on the revision's own row rather than a shared, content-addressed table: a revision is
  // read and copied whole with its files. Null is none (a revision with no skills).
  // `parent_id`: the revision that was the agent's current one when this revision was committed (null for its first), kept
  // for the v2 revisions view. `note`: the optional note a revision was committed with (the v2 note), null for none.
  `CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    parent_id TEXT REFERENCES revisions (id),
    kind TEXT NOT NULL CHECK (kind IN ('agentic', 'workflow')),
    ${json("body")},
    ${json("skills", true)},
    ${json("package", true)},
    note TEXT,
    external_version TEXT,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS revisions_by_agent ON revisions (agent_id, created_at)`,
  // `external_version`: for a revision of an externally owned agent, the version it maps there (one revision per version),
  // unique per agent; null for a revision committed here.
  `CREATE UNIQUE INDEX IF NOT EXISTS revisions_external_version ON revisions (agent_id, external_version) WHERE external_version IS NOT NULL`,

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
    -- How an ended run (state 'ended') ended apart from being done: 'escalated' (it finished its work and waits for a
    -- person, which v2 reads as completed with a review) or 'completed'; null is a plain completion. A failed or stopped
    -- run says so in its state and needs none. Written in the run's end commit (RunPatch.outcome).
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'escalated')),
    -- When the run itself was archived (its agent's archive is the agent row's): hidden from the default lists, kept.
    archived_at INTEGER,
    -- The session an imported run came from ({source, session}), written by Store.importRun; null for a run started here.
    ${json("imported_from", true)},
    -- The SHA-256 hashes (a JSON array) of the browser sign-in pointers handed to this run at its launch, never the
    -- pointers themselves. Written once with the queued run (runs.create). While the run is running, a sign-in whose
    -- pointer hashes to one of these is in use by it, so forgetting it is refused (sign-ins-store.ts), and its served
    -- output is redacted by every handed pointer. Null when the run was handed none.
    ${json("sign_in_handed", true)},
    -- When the run last left 'running' (parked or ended): a Browserbase sign-in it held keeps its save lease for the
    -- settle window after this (the context is still being written back), so a run that binds within it does not save over
    -- the write-back (sign-ins-store.ts / runs.update's save decision). Null until it first leaves running. Other vendors
    -- free the lease the instant it leaves running (no settle window), so this is read only with one.
    left_running_at INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS runs_by_agent ON runs (agent_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS runs_by_revision ON runs (revision_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS runs_claimable ON runs (state, started_at)`,
  // One run per imported session: Store.importRun is refused a session it already imported (as the old store's
  // UNIQUE (source, session) did).
  `CREATE UNIQUE INDEX IF NOT EXISTS runs_import ON runs (json_extract(imported_from, '$.source'), json_extract(imported_from, '$.session')) WHERE imported_from IS NOT NULL`,

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
  COMMANDS_ONE_ANSWER,

  // An API call's answer kept under its idempotency key, per scope.
  `CREATE TABLE IF NOT EXISTS idempotency (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    ${json("response")},
    at INTEGER NOT NULL,
    PRIMARY KEY (scope, key)
  ) STRICT`,

  // The origin key a run was started under (a create's idempotency key, or a trigger's firing key): the run it started and
  // the fingerprint of what was asked then, so a retry under the same key finds that run (runOfOrigin) and tells itself
  // from another request under the same key. Written in the run's own transaction (runs.create), so the link holds even
  // when the server went down before its answer was stored (the kept response is written later, and separately).
  `CREATE TABLE IF NOT EXISTS run_origins (
    key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    fingerprint TEXT,
    created_at INTEGER NOT NULL
  ) STRICT`,

  // Triggers (module E's), their scopes (rows only while enabled), firings, conversations and adapter settings. A trigger's
  // firings are one table: its history (shown 1, the newest HISTORY_KEPT), the due queue, and the keys kept only for their
  // day (shown 0: a run now's or a delivery's, an ignored delivery's included). A due firing keeps its next try in
  // retry_at under the engine's one backoff table, or waits for its trigger's room (waits_on: the run it waits behind).
  // max_active_runs: the most of the trigger's started runs not yet ended (a JOIN on runs), none past it.
  `CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    ${json("source")},
    ${json("target")},
    next_at INTEGER,
    last_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL,
    catchup_window_s INTEGER,
    failures_in_a_row INTEGER NOT NULL DEFAULT 0,
    ${json("disabled", true)},
    max_active_runs INTEGER CHECK (max_active_runs IS NULL OR max_active_runs BETWEEN 1 AND 100),
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
    status TEXT NOT NULL CHECK (status IN ('due', 'started', 'sent', 'skipped', 'failed', 'missed', 'ignored')),
    at INTEGER NOT NULL,
    run_id TEXT REFERENCES runs (id) ON DELETE SET NULL,
    reason TEXT,
    ${json("error", true)},
    count INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER,
    notified INTEGER,
    catch_up INTEGER,
    paused INTEGER,
    payload TEXT,
    ${json("attrs", true)},
    shown INTEGER,
    waits_on TEXT,
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
  // The computer ledger: a provider whose sessions carry no labels of their own (a phone provider's) keeps ours here, by
  // its session id (the run, the claim's epoch...), so its list, an attach by labels and the janitor outlive a restart.
  // detail is the rest of the provider's entry for the session, as it gave it (a phone's image and deadline).
  `CREATE TABLE IF NOT EXISTS computer_ledger (
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ${json("labels")},
    ${json("detail")},
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, session_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS learning (
    agent_id TEXT NOT NULL REFERENCES agents (id),
    key TEXT NOT NULL,
    ${json("value")},
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, key)
  ) STRICT`,

  // An agent's saved browser sign-ins (design 2.1, the browser sign-in rules): one live row per agent and browser provider, its
  // pointer (the vendor's context or profile id) sealed with the store's one rule (store/seal.ts, AAD
  // sign_ins|<agent>:<provider>|pointer), which the store never opens. The owner sees its name ("default") and saved_at,
  // never the pointer, and no run's tools ever do. Forgetting a sign-in moves its sealed pointer, byte for byte so it
  // still opens, into a tombstone row (sign_in_tombstones), kept only so a server started later can still cut it from
  // what a run it was handed shows; the newest 32 per agent are kept, the oldest dropped first.
  `CREATE TABLE IF NOT EXISTS sign_ins (
    agent_id TEXT NOT NULL REFERENCES agents (id),
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    pointer_sealed BLOB NOT NULL,
    saved_at INTEGER NOT NULL,
    -- This save's number: 1 at the first save, one more on every save since. A verify is guarded by it, never by saved_at,
    -- which two saves in one millisecond share (store.signIns.verify's ifSave).
    save INTEGER NOT NULL DEFAULT 1 CHECK (save >= 1),
    -- When a run that held this sign-in last verified it (saved a live session back to the vendor): the v2 view's
    -- verified_at. Null when the owner just saved it and no run has verified it since (a fresh save clears it). Written by
    -- the run path (store.signIns.verify) at a run's save, read by the view bridge (sign-ins-store.ts).
    verified_at INTEGER,
    PRIMARY KEY (agent_id, provider)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS sign_in_tombstones (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    provider TEXT NOT NULL,
    pointer_sealed BLOB NOT NULL,
    forgotten_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS sign_in_tombstones_by_agent ON sign_in_tombstones (agent_id, id)`,

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
    -- The remote server's reported info and its instructions, as it gave them: untrusted, bounded at save (mcp-store.ts).
    ${json("server_info", true)},
    instructions TEXT,
    sealed BLOB,
    refresh_holder TEXT,
    refresh_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    -- When the tools were last listed: a refresh moves this, not updated_at, so a refresh is not read as an owner edit.
    listed_at INTEGER,
    -- When the sealed credential was last set: a save with a new credential or an OAuth sign-in moves it. A save that
    -- keeps the sealed one, a refresh of the tools, and a token refresh (the server keeping the sign-in) leave it.
    -- Null with no credential.
    credential_changed_at INTEGER,
    -- When the sealed credential's access token runs out, on the store's own clock: stamped when the credential is
    -- written (a save, a token refresh) as the store's now plus the writer's measure of the token's remaining life, so a
    -- claim on any machine judges the token by the store's clock (McpServerRow.tokenLeftMs). Null when the writer gave no
    -- measure (no token set, or a writer that has none).
    token_until INTEGER
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
    state TEXT PRIMARY KEY,
    server TEXT NOT NULL,
    -- The sign-in's secret parts, the PKCE verifier and the OAuth client (with its secret), sealed together (store/seal.ts,
    -- AAD mcp_oauth_pending|<state>|sealed): bytes the store never opens, so no sign-in secret is ever in the clear here.
    sealed BLOB NOT NULL,
    -- The sign-in's non-secret working state the callback rebuilds (url, was, scope, kind, discovery, resource): no secret.
    ${json("working", true)},
    expires_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS mcp_pins (
    run_id TEXT PRIMARY KEY REFERENCES runs (id),
    ${json("body")},
    pinned_at INTEGER NOT NULL
  ) STRICT`,

  // A run's launch record: the one body the server writes when it starts a run (start = INSERT run), read by the runner at
  // its claim to build the run's spec. It replaces the per-run serve.json the old per-run process read: one row per run,
  // written in the same transaction as the queued run, never after. `body` is the launch JSON (run-launch.ts: the first
  // input, title, place, effort, cap, and the trigger and origin that started it); `sealed` holds any secret sealed with
  // the server's key outside the store (AAD run_launch|<run_id>|sealed), or null when the launch holds none.
  `CREATE TABLE IF NOT EXISTS run_launch (
    run_id TEXT PRIMARY KEY REFERENCES runs (id),
    ${json("body")},
    sealed BLOB,
    created_at INTEGER NOT NULL
  ) STRICT`,

  // A running run's live view (the tool it runs now, its partial text): one row, outside the journal, overwritten in place
  // by its runner's tick and dropped at its end.
  `CREATE TABLE IF NOT EXISTS run_live (
    run_id TEXT PRIMARY KEY REFERENCES runs (id),
    ${json("state")},
    updated_at INTEGER NOT NULL
  ) STRICT`,

  // A run's computer sessions' viewer hand-overs (store.liveViewers, browser-live.ts): one row per run, computer kind
  // (browser, desktop, phone) and session tag, the viewer token sealed (sealedAt.liveViewer), written under the claim of
  // `runner` at `epoch`. Gone with the run's end, a take or reclaim at a newer epoch, and the run. The predecessor table
  // browser_viewers is dropped at a server's open (sqlite/store.ts): its rows are ephemeral, so none migrate.
  `CREATE TABLE IF NOT EXISTS computer_viewers (
    run_id TEXT NOT NULL REFERENCES runs ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('browser', 'desktop', 'phone')),
    tag TEXT NOT NULL,
    port INTEGER NOT NULL,
    viewer_id TEXT NOT NULL,
    sealed BLOB NOT NULL,
    at INTEGER NOT NULL,
    runner TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    host TEXT,
    PRIMARY KEY (run_id, kind, tag)
  ) STRICT`,

  // Learning on the runner: what a run's end-of-run turn kept (the turn it asked and answered, and the proposal checked from
  // it), written in the same commit as the run's end, beside the learning run that grades and merges it (learning_run_id,
  // none for a learning dropped before it was proposed). Read by the learning routes (the pre-merge view), by the
  // learning run, and by the reader of a run's learning end (store-reads/learning.ts).
  `CREATE TABLE IF NOT EXISTS learning_proposals (
    run_id TEXT PRIMARY KEY REFERENCES runs (id),
    agent_id TEXT NOT NULL REFERENCES agents (id),
    ${json("turn")},
    ${json("proposal")},
    learning_run_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS learning_proposals_by_agent ON learning_proposals (agent_id, created_at DESC)`,
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
