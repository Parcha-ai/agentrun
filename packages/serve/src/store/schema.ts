// The store's one schema, version 11 (design 2.1). Nothing migrates into it: the rewrite replaces the old stores, and a store
// an older build made is refused as a version this build does not know. The server sets it up once at its start (a
// store_meta row holds the version); a runner refuses a version it does not know. Version 2 adds the computer ledger;
// version 3 numbers each save of a sign-in (sign_ins.save); version 4 stamps an MCP token's end (mcp_servers.token_until);
// version 5 maps an externally owned agent (agents.external_ref, revisions.external_version); version 6 tells a person's
// stop from a cancel (runs.outcome 'stopped' or 'cancelled'); version 7 keeps a run's learning by round
// (learning_proposals.round: a follow-up to a run that ended looks back again, a round of its own); version 8 adds the
// run-change feed (run_changes), each channel post's tries (channel_attempts) and the claim a post's try settles under
// (channel_posts.claim); version 9 adds where a live viewer answers (computer_viewers.host, a runner's live host,
// live-reach.ts); version 10 pairs a person's own computer (paired_computers, pairing_codes); version 11 keeps a command's answer
// (commands.answer). An agent's MCP tools are pinned on its revision when it is saved (revisions.mcp_pin, REVISIONS_MCP_PIN),
// in place of each run's pin at its first claim (the mcp_pins table): a server open adds the column to a store an earlier
// build of this version made and drops the table, so a revision saved before has no pin until its first run pins it.
// Its monid endpoints are pinned beside them (revisions.monid_pin, REVISIONS_MONID_PIN), added at a server open the same way.
// A run's cost says whether it is the most the run can have cost (runs.cost_upper_bound, RUNS_COST_UPPER_BOUND), added at a
// server open the same way. A run's labels (runs.labels, RUNS_LABELS) are added at a server open the same way, and so is
// a trigger's package mark (triggers.template_id, TRIGGERS_TEMPLATE_ID).
// The template packages imported from GitHub (imported_templates) are a table of their own that nothing
// else reads, so it needs no version: the server adds it at its open to a store an earlier build of this version made
// (IMPORTED_TEMPLATES), as it does the one-answer index. A hosted machine's minted token (minted_tokens, MINTED_TOKENS) is
// added the same way, and so is each runner's word that it is there and whether it refused to claim (runners, RUNNERS),
// and each computer a run made, from its create to its proven delete (computer_intervals, COMPUTER_INTERVALS). Each runner's
// version and slots (runners.version, .slots: RUNNERS_ADDED), each hand-back (hand_backs, HAND_BACKS) and each claim of a
// run with the turn it works and its attempt at it (run_attempts, RUN_ATTEMPTS) are added the same way, and so is the
// learning ledger (learning_ledger, learning_spend: LEARNING_LEDGER, LEARNING_SPEND).
// Conventions: every time is INTEGER epoch milliseconds; JSON is TEXT checked by json_valid; money is REAL US dollars;
// sealed columns hold ciphertext only (sealed with the server's key outside the store), so the store never sees a secret
// in the clear. Foreign keys are on (the connection's pragma).
//
// STORE_DDL is the control plane and the runs: agents and revisions (with a template's package), runs (state, the claim's
// epoch, runner, claimed_until and wake_at, cost, metrics, summary), commands, idempotency, triggers (their scopes,
// firings, conversations and settings), the channel outbox and told ledger, the review ledger, settings, sealed keys,
// learning state, the MCP registry, pending MCP sign-ins, and the computer ledger. PI_DDL is pi-durable's
// journal tables, keyed by run_id (store/journal): one schema for every run's journal, so a query joins runs and their
// journals.

// Version 12 keeps each run's listing on its row (RUN_LISTING_COLUMNS): what a runs list shows of it, so a list reads rows
// alone. Version 13 names the runner in a process of its own that minted a hosted machine's token (minted_tokens.runner,
// .incarnation), the run the machine works for (.run), why the server refused to relay its dial (.refused), and where each
// such runner takes the dials the server relays to it (runners.host and .port, dial-relay.ts). Version 14 keeps when a run or
// an agent was purged (runs.purged_at, agents.purged_at; DELETE /runs/{id} and /agents/{id}, agent-delete.ts): its row is
// then a tombstone, its content gone and its cost kept. Version 15 keeps the disk a run's launch named as its own
// (runs.disk; a run on one learns nothing, learn/learning-of.ts). The server upgrades these in place at its open
// (listingUpgrade from 11, relayUpgrade from 12, purgeUpgrade from 13, then diskUpgrade from 14); a runner waits for it.
export const SCHEMA_VERSION = 15;

/** One answer per approval of a run: a second approve or deny command naming the same approval is refused
 *  (StoreConstraint), so the first answer a person gives wins from the moment it is written, before the runner takes it
 *  (runs-over-store.ts approve). In STORE_DDL, and added at a server open to a store an earlier build of this version made. */
/** One unrefused answer per approval of a run: an answer the runner refused (its run could not resume) holds no place, so
 *  the person can answer again. */
export const ONE_ANSWER_INDEX = "commands_one_answer";
/** The connector's own command rows, without parsing another connector's events on every heartbeat. */
export const NATIVE_COMMANDS_INDEX = `CREATE INDEX IF NOT EXISTS settings_native_commands ON settings (connector_id, key) WHERE key >= 'native.remote.command.' AND key < 'native.remote.command/'`;

export const COMMANDS_ONE_ANSWER = `CREATE UNIQUE INDEX IF NOT EXISTS ${ONE_ANSWER_INDEX} ON commands (run_id, json_extract(body, '$.approval')) WHERE kind IN ('approve', 'deny') AND refused IS NULL`;

const json = (column: string, nullable = false) => `${column} TEXT${nullable ? "" : " NOT NULL"} CHECK (${column} IS NULL OR json_valid(${column}))`;

/** A revision's MCP pin, as its save listed the tools (JSON, null when it grants no MCP tool). In STORE_DDL, and added at a
 *  server open to a store an earlier build of this version made (one that pinned each run in mcp_pins, dropped at that open). */
export const REVISIONS_MCP_PIN = `ALTER TABLE revisions ADD COLUMN ${json("mcp_pin", true)}`;
/** A revision's monid pin (JSON, null for none): in STORE_DDL, and added at a server open as REVISIONS_MCP_PIN is. */
export const REVISIONS_MONID_PIN = `ALTER TABLE revisions ADD COLUMN ${json("monid_pin", true)}`;
/** Whether a run's stored cost (cost_usd) is the most it can have cost, not its cost: 1 when it counts a request cut with
 *  no answer at what its cap held for it (runner.ts CUT_AT_HOLD), written in the end's commit with the cost; 0 otherwise,
 *  an unknown cost's included. */
const COST_UPPER_BOUND = "cost_upper_bound INTEGER NOT NULL DEFAULT 0 CHECK (cost_upper_bound IN (0, 1))";
/** The bound beside a run's cost: in STORE_DDL, and added at a server open to a store an earlier build of this version made,
 *  as REVISIONS_MCP_PIN is (a run it ended reads 0: an exact cost or an unknown one, as it was read then). */
export const RUNS_COST_UPPER_BOUND = `ALTER TABLE runs ADD COLUMN ${COST_UPPER_BOUND}`;
/** A run's labels (JSON, null for none): in STORE_DDL, and added at a server open to a store an earlier build of this version
 *  made, as RUNS_COST_UPPER_BOUND is (a run started before reads as given none). */
export const RUNS_LABELS = `ALTER TABLE runs ADD COLUMN ${json("labels", true)}`;
/** Version 14 → 15 on SQLite (the server's open, sqlite/store.ts), given the runs' columns now: each run's disk
 *  (RunRow.disk), written for every run already there from its launch body, as a new run's is at its create, and the
 *  version, in one durable write. A run whose launch named no disk of its own reads as the default disk's, and so does a
 *  run purged before (its launch body gone): nothing of it is left to learn from. */
export function diskUpgrade(runColumns: ReadonlySet<string>): readonly string[] {
  return [
    ...(runColumns.has("disk") ? [] : ["ALTER TABLE runs ADD COLUMN disk TEXT"]),
    "UPDATE runs SET disk = (SELECT json_extract(body, '$.archil_disk.disk_id') FROM run_launch WHERE run_launch.run_id = runs.id AND json_extract(body, '$.archil_disk.kind') = 'launch')",
    "UPDATE store_meta SET schema_version = 15 WHERE singleton = 1",
  ];
}
/** A trigger's package mark (TriggerRow.templateId): the id of the template package whose apply made or last kept it, null
 *  for one a person made. In STORE_DDL, and added at a server open to a store an earlier build of this version made, as
 *  RUNS_LABELS is (a trigger made before reads as no package's). */
export const TRIGGERS_TEMPLATE_ID = "ALTER TABLE triggers ADD COLUMN template_id TEXT";

/** A template package imported from GitHub (POST /v2/templates/import), by its id (`github:<owner>/<repo>[/<path>]`): its
 *  source as given (ref and all), the full commit SHA read, the GitHub account that publishes it, and its files as read
 *  (`files`, a JSON object of path to base64). A re-import of the id replaces the row. The server checks the files again
 *  as it loads them at its start (templates.ts readPackage); nothing in them runs. In STORE_DDL, and added at a server
 *  open to a store an earlier build of this version made. */
export const IMPORTED_TEMPLATES = `CREATE TABLE IF NOT EXISTS imported_templates (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    sha TEXT NOT NULL,
    publisher TEXT NOT NULL,
    ${json("files")},
    imported_at INTEGER NOT NULL
  ) STRICT`;

/** A hosted machine's minted token (a dial provider's create, spec/computer/attach.md): its computerd dials the attach
 *  socket and fetches the daemon with it. By the machine (its name, from its create's request id): the token's SHA-256
 *  alone (hex), what the machine must say it is at hello (kind, os, arch), and when the token ends (`expires_at`, the
 *  machine's backstop) or was revoked (its delete). A row past its end goes at the next mint. `runner` and `incarnation`
 *  (version 13): the runner in a process of its own that minted it, and its incarnation, to which the server relays the
 *  machine's socket (dial-relay.ts); null for the server's own process. `run` (version 13): the run the machine works for,
 *  as its create named it, which the words about its dial say; null for a machine of no run. `refused` (version 13): why
 *  the server refused to relay its dial, in its 503's words (never the token), which the minting runner's create reads to
 *  end its wait; null while none was, and again at a mint. In STORE_DDL, and added at a server open to a store an earlier
 *  build of this version made. */
export const MINTED_TOKENS = `CREATE TABLE IF NOT EXISTS minted_tokens (
    machine TEXT PRIMARY KEY,
    token_sha256 TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    os TEXT NOT NULL,
    arch TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    runner TEXT,
    incarnation TEXT,
    run TEXT,
    refused TEXT
  ) STRICT`;

/** Each computer a run's claim made through its provider (a sandbox, a desktop, a phone), by the provider's own id for it:
 *  so an operator can see how long each lived for its run, find one left running after its run, and match the provider's
 *  invoice by its id. `kind`, and what it was made with (`gpu_type` and `gpu_count`, `cpus`, `memory_mb`, `disk_gb`): the
 *  provider's own figures where its answer gave them (CreatedComputer.resources), else what its create asked, null where
 *  neither says (a hosted vendor that sizes its own machines and says nothing): never a guess. `booked_ms`: how much of
 *  its time a claim of its run booked on the run's ledger (compute-cost.ts), the rest being time no claim held. `kept`: 1 once
 *  the run's park kept it past the claim (computer-kept.ts). `ended_at`: written once, only when the provider's delete of
 *  it answered ok; null while none did (still running, or its delete failed or was never asked), never a guessed end. Not
 *  the agent's own computer (it outlives every run), a paired one or --faux's. In STORE_DDL, and added at a server open to
 *  a store an earlier build of this version made, as MINTED_TOKENS is. */
export const COMPUTER_INTERVALS = `CREATE TABLE IF NOT EXISTS computer_intervals (
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    kind TEXT,
    gpu_type TEXT,
    gpu_count INTEGER,
    cpus REAL,
    memory_mb INTEGER,
    disk_gb REAL,
    started_at INTEGER NOT NULL,
    kept INTEGER NOT NULL DEFAULT 0 CHECK (kept IN (0, 1)),
    ended_at INTEGER,
    booked_ms INTEGER NOT NULL DEFAULT 0 CHECK (booked_ms >= 0),
    PRIMARY KEY (provider, provider_id)
  ) STRICT`;
/** The columns a computer_intervals an earlier build of this version made lacks (its disk and its booked time), each
 *  added at a server open where missing (sqlite/store.ts). */
export const COMPUTER_INTERVALS_ADDED: Readonly<Record<string, string>> = {
  disk_gb: "ALTER TABLE computer_intervals ADD COLUMN disk_gb REAL",
  booked_ms: "ALTER TABLE computer_intervals ADD COLUMN booked_ms INTEGER NOT NULL DEFAULT 0 CHECK (booked_ms >= 0)",
};
/** A run's computers, read by its run (store.computerIntervals.forRun). */
export const COMPUTER_INTERVALS_RUN = "CREATE INDEX IF NOT EXISTS computer_intervals_run ON computer_intervals (run_id, started_at)";

/** Each runner's word that it is there (runner/presence.ts), every runner's, beside a server or in a process of its own:
 *  its name, its incarnation (its process since its start, the one its relay's minted tokens and proofs name), why it
 *  refused to claim any run (`refused`, its words; null for one that claims), where its relay's attach listener takes the
 *  dials the server relays to it (`host` and `port`, dial-relay.ts; null for a runner with no relay) and when it last said
 *  it was there. The server reads them for whether any runner here can take a run (a launch's 503 runner_refused,
 *  capabilities' runner_refused, health's runner check) and where to relay a dial (computer-attach.ts liveRelays). In
 *  STORE_DDL. A store an earlier build of version 13 made kept the relays in a table of their own (runner_relays): the
 *  server's open drops it and makes this one (sqlite/store.ts), as it drops browser_viewers, with no version: the rows
 *  are heartbeats renewed every 10 s, so none is copied, and a runner waits for that server (StoreAwaitsServer). */
export const RUNNERS = `CREATE TABLE IF NOT EXISTS runners (
    runner TEXT PRIMARY KEY,
    incarnation TEXT NOT NULL,
    refused TEXT,
    host TEXT,
    port INTEGER,
    seen_at INTEGER NOT NULL,
    version TEXT,
    slots INTEGER
  ) STRICT`;
/** What a runner says of itself for the server's capacity read (GET /v2/capacity, capacity.ts): its build's version
 *  (`version`) and the most runs it holds at once (`slots`), each null on a row an earlier build wrote. In RUNNERS, and
 *  added where missing at a server open to a runners table an earlier build of this version made, as
 *  COMPUTER_INTERVALS_ADDED is: nullable, so nothing is copied and no row is refused. */
export const RUNNERS_ADDED: Readonly<Record<string, string>> = {
  version: "ALTER TABLE runners ADD COLUMN version TEXT",
  slots: "ALTER TABLE runners ADD COLUMN slots INTEGER",
};
/** Each hand-back (store.release that leaves its run running: a runner's drain, a loop that closed itself, a claim given
 *  back): the run, the runner that let it go, the epoch it let go of and when, on the deadlines' clock. Counts and ids
 *  only; the capacity read (capacity.ts) counts the rows within its window. A release's own write keeps it, in the same
 *  transaction, and removes the rows older than HAND_BACKS_KEPT_MS. In STORE_DDL, and made at a server open on a store an
 *  earlier build of this version made. */
export const HAND_BACKS = `CREATE TABLE IF NOT EXISTS hand_backs (
    run_id TEXT NOT NULL,
    runner TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    at INTEGER NOT NULL
  ) STRICT`;
/** The hand-backs by time, for the capacity read's window and the release's prune. */
export const HAND_BACKS_AT = "CREATE INDEX IF NOT EXISTS hand_backs_at ON hand_backs (at)";
/** A run's hand-backs, for its purge and its delete (dropRunContent), so neither scans every hand-back kept. */
export const HAND_BACKS_RUN = "CREATE INDEX IF NOT EXISTS hand_backs_run ON hand_backs (run_id)";
/** How long a hand-back's row is kept: the longest window the capacity read takes. */
export const HAND_BACKS_KEPT_MS = 24 * 60 * 60_000;

/** Each claim of a run (store.runAttempts, RunAttemptRow): the turn it works and its attempt at it, why the attempt before
 *  was cut (`cause`: drain, crash, lease_lapse, retry; null on a turn's first), why this one let the run go unfinished
 *  (`cut`), its runner, the run's state it took the run from, the first journal entry id it could write
 *  (`journal_from`) and when it claimed. Written in the claim's own transaction, its cut in its release's. Data only:
 *  the usage read (run-usage.ts) splits a run's cost by it; source-project recovery uses the actual claim and journal
 *  boundary to report a terminal attempt with no checkpoint, never to replay work or invent a capture. In STORE_DDL, and
 *  added at a server open to a store an earlier build of this version made, as COMPUTER_INTERVALS is: a claim made before
 *  it has no row. */
export const RUN_ATTEMPTS = `CREATE TABLE IF NOT EXISTS run_attempts (
    run_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    turn INTEGER NOT NULL CHECK (turn >= 1),
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    cause TEXT CHECK (cause IS NULL OR cause IN ('drain', 'crash', 'lease_lapse', 'retry')),
    cut TEXT CHECK (cut IS NULL OR cut IN ('drain', 'lease_lapse', 'retry')),
    runner TEXT NOT NULL,
    from_state TEXT NOT NULL,
    journal_from INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, epoch)
  ) STRICT`;

/** The learning ledger (learn/ledger.ts): one row a run, written by each patch that leaves the run ended (applyRunPatch,
 *  in that patch's transaction) and by a healed cost: who answered it (`path`, null when its end named none), the
 *  revision that ran it, why it was not served alone, the job's own $ and its rounds' look-back, and whether its cost is
 *  known (`cost`), and the end it was written for (`at`: the run's ended_at). Gone with the run's purge or delete (its
 *  cost stays on the run's tombstone). Figures only, no run text. In STORE_DDL, and made at a server open on a store an
 *  earlier build of this version made: a run that ended before it has no row, and one a runner of that build ended again
 *  has a row for an earlier end; its reader records it from its run row either way (store-reads/learning.ts). */
export const LEARNING_LEDGER = `CREATE TABLE IF NOT EXISTS learning_ledger (
    run_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    path TEXT CHECK (path IS NULL OR path IN ('agent', 'handed_back', 'workflow', 'replay', 'audit')),
    workflow TEXT,
    digest TEXT,
    not_served TEXT CHECK (not_served IS NULL OR not_served IN ('cost_stop', 'cut')),
    job_usd REAL,
    look_back_usd REAL,
    cost TEXT NOT NULL CHECK (cost IN ('known', 'unknown', 'at_most')),
    at INTEGER NOT NULL
  ) STRICT`;
export const LEARNING_LEDGER_AGENT = "CREATE INDEX IF NOT EXISTS learning_ledger_agent ON learning_ledger (agent_id)";
/** Each learning cost, by the revision it is for (learn/ledger.ts SpendRow): a compile turn (`round`, the round that asked
 *  it), a check's replay run or an audit's shadow run (round 0, `of_run` the run it audits), with its $ (null: unknown).
 *  Written with its run's ledger row, replaced whole each time; gone with its run's purge or delete, and with the purge
 *  or delete of the run it audits. */
export const LEARNING_SPEND = `CREATE TABLE IF NOT EXISTS learning_spend (
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('compile', 'check', 'audit')),
    round INTEGER NOT NULL CHECK (round >= 0),
    agent_id TEXT NOT NULL,
    of_run TEXT,
    workflow TEXT,
    digest TEXT,
    usd REAL,
    at INTEGER NOT NULL,
    PRIMARY KEY (run_id, kind, round)
  ) STRICT`;
export const LEARNING_SPEND_AGENT = "CREATE INDEX IF NOT EXISTS learning_spend_agent ON learning_spend (agent_id)";
export const LEARNING_SPEND_OF_RUN = "CREATE INDEX IF NOT EXISTS learning_spend_of_run ON learning_spend (of_run) WHERE of_run IS NOT NULL";

/** Version 13 → 14 on SQLite (the server's open, sqlite/store.ts), given the runs' and the agents' columns now: when each
 *  run and each agent was purged (null: none was), and the version, in one durable write. */
export function purgeUpgrade(runColumns: ReadonlySet<string>, agentColumns: ReadonlySet<string>): readonly string[] {
  return [
    ...(runColumns.has("purged_at") ? [] : ["ALTER TABLE runs ADD COLUMN purged_at INTEGER"]),
    ...(agentColumns.has("purged_at") ? [] : ["ALTER TABLE agents ADD COLUMN purged_at INTEGER"]),
    "UPDATE store_meta SET schema_version = 14 WHERE singleton = 1",
  ];
}

/** Version 12 → 13 on SQLite (the server's open, sqlite/store.ts), given minted_tokens' columns now: the minting runner,
 *  its incarnation, the machine's run and a refused relay's words on each token's row (none of the rows there has one: the
 *  server's own process minted them, naming no run), the runners (where their relays answer), and the version, in one
 *  durable write. */
export function relayUpgrade(mintedColumns: ReadonlySet<string>): readonly string[] {
  return [
    ...["runner", "incarnation", "run", "refused"].filter((column) => !mintedColumns.has(column)).map((column) => `ALTER TABLE minted_tokens ADD COLUMN ${column} TEXT`),
    RUNNERS,
    "UPDATE store_meta SET schema_version = 13 WHERE singleton = 1",
  ];
}

/** A run's listing on its row (version 12): what a runs list shows of the run, so a list reads rows alone and never builds
 *  a run's view. `list_mark` moves (+1) in the transaction of every write that can change what the run's view shows: its
 *  journal's commits (store/journal/storage.ts), its row's state, claim, cost and end (runs_list_moved), its commands
 *  (commands_list_moved), its learning's rows (learning_list_moved), and its learning run's or audit's own moves
 *  (runs_list_parent). The server rebuilds a listing from the run's view (store-view.ts listingOverStore, run-listing.ts)
 *  and writes it with the mark it read before it built (`listing_mark`), only while list_mark is still that mark: a write
 *  that lands meanwhile keeps the row as it left it (its list_status too), behind (listing_mark < list_mark), and it is
 *  built again: a crash between a write and its listing leaves a row that says
 *  it is behind, never one that says it is current. `listing` is the list item without the parts read when it is listed
 *  (console_url, archived_at), with the secrets it was cut of (a list builds one cut of other secrets again: store-view.ts builtOfNow); `list_status` its status, which a status filter reads in SQL; `listing_live` whether a runner
 *  held the run when it was built (its status reads otherwise once that claim runs out); `listing_until` when it goes stale
 *  by the clock alone (an ask that expires, or the retry of a build that withheld the run for a sign-in it could not read
 *  back); `listing_flags` what outside the run it read (LISTING_HELD: learning held for
 *  its owner's OK on its agent's folder; LISTING_KEYED: a failed run's error words, which read the server's keys). */
export const RUN_LISTING_COLUMNS = [
  "list_mark INTEGER NOT NULL DEFAULT 1",
  json("listing", true),
  "list_status TEXT",
  "listing_mark INTEGER NOT NULL DEFAULT 0",
  "listing_live INTEGER NOT NULL DEFAULT 0 CHECK (listing_live IN (0, 1))",
  "listing_until INTEGER",
  "listing_flags INTEGER NOT NULL DEFAULT 0",
] as const;
/** listing_flags: the run's learning holds items for its owner's OK, read as they stand on its agent's folder now. */
export const LISTING_HELD = 1;
/** listing_flags: a failed run's error words, which name a refused key by the server's keys and settings. */
export const LISTING_KEYED = 2;

/** A run's status from its row alone, where its row says it (an end that is no person's stop of an agentic run): the status
 *  its view reads (store-view.ts STATUS_OF), in SQL. Null for any other run, whose listing says it once it is built. */
export const SETTLED_LIST_STATUS = `CASE
    WHEN state = 'ended' THEN 'completed'
    WHEN state = 'failed' THEN 'failed'
    WHEN state = 'stopped' AND (outcome IS NULL OR outcome <> 'stopped' OR imported_from IS NOT NULL
      OR (SELECT kind FROM revisions WHERE revisions.id = runs.revision_id) <> 'agentic') THEN 'cancelled'
    ELSE NULL END`;

/** The listing's indexes and triggers (RUN_LISTING_COLUMNS), after every table they name. A write to a run's row moves its
 *  mark and sets its list_status from the row (SETTLED_LIST_STATUS: a settled run's status, else none until its listing
 *  is built), so a status filter never reads a status the row has left. The parent trigger moves the mark of the run a
 *  learning run grades (learning_proposals.learning_run_id) or an audit's shadow run audits (its id after "audit.",
 *  learn/audit.ts shadowRunId), since each run's view reads those. */
export const RUN_LISTING_DDL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS runs_listing_behind ON runs (started_at) WHERE listing_mark < list_mark`,
  `CREATE INDEX IF NOT EXISTS runs_listing_live ON runs (started_at) WHERE listing_live = 1`,
  `CREATE INDEX IF NOT EXISTS runs_listing_until ON runs (listing_until) WHERE listing_until IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS runs_by_list_status ON runs (list_status, started_at)`,
  `CREATE INDEX IF NOT EXISTS runs_listing_flagged ON runs (agent_id) WHERE listing_flags <> 0`,
  `CREATE INDEX IF NOT EXISTS learning_proposals_by_learning_run ON learning_proposals (learning_run_id) WHERE learning_run_id IS NOT NULL`,
  `CREATE TRIGGER IF NOT EXISTS runs_list_moved AFTER UPDATE OF state, epoch, runner, cost_usd, cost_upper_bound, metrics, summary, outcome, imported_from, sign_in_handed, labels, ended_at ON runs
    BEGIN
      UPDATE runs SET list_mark = list_mark + 1, list_status = ${SETTLED_LIST_STATUS} WHERE id = NEW.id;
    END`,
  `CREATE TRIGGER IF NOT EXISTS runs_list_parent AFTER UPDATE OF list_mark ON runs
    WHEN substr(NEW.id, 1, 6) = 'audit.' OR EXISTS (SELECT 1 FROM learning_proposals WHERE learning_run_id = NEW.id)
    BEGIN
      UPDATE runs SET list_mark = list_mark + 1
        WHERE (substr(NEW.id, 1, 6) = 'audit.' AND id = substr(NEW.id, 7)) OR id IN (SELECT run_id FROM learning_proposals WHERE learning_run_id = NEW.id);
    END`,
  `CREATE TRIGGER IF NOT EXISTS commands_list_moved AFTER INSERT ON commands
    BEGIN
      UPDATE runs SET list_mark = list_mark + 1 WHERE id = NEW.run_id;
    END`,
  `CREATE TRIGGER IF NOT EXISTS commands_list_settled AFTER UPDATE OF taken_at, refused ON commands
    BEGIN
      UPDATE runs SET list_mark = list_mark + 1 WHERE id = NEW.run_id;
    END`,
  `CREATE TRIGGER IF NOT EXISTS learning_list_moved AFTER INSERT ON learning_proposals
    BEGIN
      UPDATE runs SET list_mark = list_mark + 1 WHERE id = NEW.run_id;
    END`,
  `CREATE TRIGGER IF NOT EXISTS learning_list_changed AFTER UPDATE ON learning_proposals
    BEGIN
      UPDATE runs SET list_mark = list_mark + 1 WHERE id = NEW.run_id;
    END`,
];

/** Version 11 → 12 on SQLite (the server's open, sqlite/store.ts), given the runs table's columns now: the listing's columns
 *  it lacks, its indexes and triggers, every settled run's status from its row (SETTLED_LIST_STATUS), and the version, in
 *  one durable write. Every run starts behind (listing_mark 0 < list_mark 1): the server's lister builds each listing in
 *  the background, the runs no runner holds first. */
export function listingUpgrade(runColumns: ReadonlySet<string>): readonly string[] {
  return [
    ...RUN_LISTING_COLUMNS.filter((column) => !runColumns.has(column.split(" ")[0]!)).map((column) => `ALTER TABLE runs ADD COLUMN ${column}`),
    ...RUN_LISTING_DDL,
    `UPDATE runs SET list_status = ${SETTLED_LIST_STATUS}`,
    "UPDATE store_meta SET schema_version = 12 WHERE singleton = 1",
  ];
}

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
    external_ref TEXT,
    -- When the agent was purged (DELETE /agents/{id} of an archived agent made here): its row is then a tombstone, its
    -- name, description and revisions' content blanked, kept for its runs' tombstones and their cost. Null: not purged.
    purged_at INTEGER
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS agents_external ON agents (external_ref) WHERE external_ref IS NOT NULL`,
  // A revision's skills (the P4 fold of the old agent store's skill table): the revision's own skill files, a JSON object
  // keyed by the skill's path under `.agents/skills/` to its text. The body's `skills` map keeps the path to the text's
  // SHA-256 (so two revisions with the same files are one body, and a view can show each file's size), and this column
  // holds the texts themselves, on the revision's own row rather than a shared, content-addressed table: a revision is
  // read and copied whole with its files. Null is none (a revision with no skills).
  // `parent_id`: the revision that was the agent's current one when this revision was committed (null for its first), kept
  // for the v2 revisions view. `note`: the optional note a revision was committed with (the v2 note), null for none.
  // `mcp_pin`: the MCP tools the revision grants, as their servers listed them when it was saved (mcp-gateway.ts McpPin:
  // per server its URL then, the granted tools, their prices), which every run of it calls; null when it grants none.
  // `monid_pin`: its monid endpoints as monid listed them when it was saved (agent-body.ts MonidPinBody); null for none.
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
    created_at INTEGER NOT NULL,
    ${json("mcp_pin", true)},
    ${json("monid_pin", true)}
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
    ${COST_UPPER_BOUND},
    ${json("metrics", true)},
    summary TEXT,
    -- How the run ended beside its state (RunOutcome). An ended run: 'escalated' (it finished its work and waits for a
    -- person, which v2 reads as completed with a review) or 'completed'; null is a plain completion. A stopped run:
    -- 'stopped' when a person stopped it (its turn is over, not the run: a message reopens it) or 'cancelled' (over for
    -- good). A failed run says so in its state and needs none. Written in the run's end commit (RunPatch.outcome).
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'escalated', 'stopped', 'cancelled')),
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
    -- The caller's labels (RunLabels): a JSON object of strings, set once with the queued run (runs.create), opaque to the
    -- server and only filtered on (runs.list). Null when it was given none. Added at a server open to a store an earlier
    -- build of this version made (RUNS_LABELS), its runs reading as given none.
    ${json("labels", true)},
    -- The disk the run's launch named as its own (RunRow.disk: a customer's Archil disk, by its id), set once with the queued
    -- run from its launch body; null for the default disk's. Learning reads an agent's runs on one disk alone. Version 15
    -- (diskUpgrade): added then and written from each run's launch. A purge keeps it on the run's tombstone.
    disk TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    -- The run's listing (RUN_LISTING_COLUMNS): what a runs list shows of it, kept on its row so a list reads rows alone.
    ${RUN_LISTING_COLUMNS.join(",\n    ")},
    -- When the run was purged (DELETE /runs/{id}, Runs.purge): its row is then a tombstone, every record of what it was
    -- given or did gone and its cost kept, which no list shows and every total still sums. Null: not purged.
    purged_at INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS runs_by_agent ON runs (agent_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS runs_by_revision ON runs (revision_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS runs_claimable ON runs (state, started_at)`,
  // The run-change feed (Runs.changedSince): a row for each run reaching a final state or let go by its runner (parked, or
  // running with no runner), written by the trigger below in the transaction of the write that made it, so no writer of a
  // run's state or runner can miss it and none lands without its write. `seq` numbers them in commit order (one writer).
  `CREATE TABLE IF NOT EXISTS run_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    state TEXT NOT NULL,
    ended_at INTEGER,
    epoch INTEGER NOT NULL,
    runner TEXT
  ) STRICT`,
  // A change is a move of the state or the runner into a final state, parked, or running with none: a fence's touch of
  // the row (epoch = epoch), a claim, a renew and a cost or summary write are none.
  `CREATE TRIGGER IF NOT EXISTS runs_changed AFTER UPDATE OF state, runner ON runs
    WHEN (OLD.state IS NOT NEW.state OR OLD.runner IS NOT NEW.runner)
      AND (NEW.state IN ('ended', 'stopped', 'failed', 'parked') OR (NEW.state = 'running' AND NEW.runner IS NULL))
    BEGIN
      INSERT INTO run_changes (run_id, state, ended_at, epoch, runner) VALUES (NEW.id, NEW.state, NEW.ended_at, NEW.epoch, NEW.runner);
    END`,
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
    tries INTEGER NOT NULL DEFAULT 0,
    ${json("answer", true)}
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
  // retry_at under the engine's one backoff table, or waits for its trigger's room (waits_on: what it waits behind, a run's
  // id, or a firing's key while the trigger has no run yet and a firing its launch hook's host took, or one mid-hand,
  // holds the room). retry_at also keeps a sent firing's start_by: the time until which that host may start its run.
  // max_active_runs: the most of the trigger's runs in progress (started and not yet ended, a JOIN on runs, or a sent
  // firing with no run inside its start_by), none past it.
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
    -- The template package whose apply made or last kept the trigger (TriggerRow.templateId), null for one a person made:
    -- a template update removes only triggers marked with its own package. Written by the apply alone; a move to another
    -- agent clears it. Added at a server open to a store an earlier build of this version made (TRIGGERS_TEMPLATE_ID).
    template_id TEXT,
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
    claim TEXT,
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
  // Each try of a channel's post (the outbound webhook's deliveries log): kept to the newest few per channel, each once by
  // its try's id.
  `CREATE TABLE IF NOT EXISTS channel_attempts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    try_id TEXT NOT NULL UNIQUE,
    channel TEXT NOT NULL,
    post_id TEXT NOT NULL,
    moment TEXT NOT NULL,
    at INTEGER NOT NULL,
    status_code INTEGER,
    latency_ms INTEGER NOT NULL,
    error TEXT,
    retry_at INTEGER,
    redelivery INTEGER NOT NULL CHECK (redelivery IN (0, 1))
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS channel_attempts_by_channel ON channel_attempts (channel, seq)`,

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
    connector_id TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  NATIVE_COMMANDS_INDEX,
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
  // A person's own machine paired with this server (spec/computer/attach.md): its driver dials the attach socket with the
  // token pairing gave it, of which only the SHA-256 is kept (hex). `hello`: the driver's hello at pairing, what it paired
  // as; `driver`: the build its last hello named. `seen_at`: its last socket's hello; `revoked_at`: when it was removed,
  // after which its token dials no more (the row stays, so a run that names it is told it was removed).
  `CREATE TABLE IF NOT EXISTS paired_computers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ${json("hello")},
    driver TEXT NOT NULL,
    ${json("labels")},
    token_sha256 TEXT NOT NULL UNIQUE,
    pairing_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    seen_at INTEGER,
    revoked_at INTEGER
  ) STRICT`,
  // A pairing code, by its SHA-256 alone (hex): good once, until expires_at. A used one is deleted as it pairs. `id` names
  // the pairing (not the code): the console that made it reads it back on the computer the code made (paired_computers.pairing_id).
  `CREATE TABLE IF NOT EXISTS pairing_codes (
    id TEXT NOT NULL UNIQUE,
    code_sha256 TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS learning (
    agent_id TEXT NOT NULL REFERENCES agents (id),
    key TEXT NOT NULL,
    ${json("value")},
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, key)
  ) STRICT`,
  IMPORTED_TEMPLATES,
  MINTED_TOKENS,
  RUNNERS,
  HAND_BACKS,
  HAND_BACKS_AT,
  HAND_BACKS_RUN,
  COMPUTER_INTERVALS,
  COMPUTER_INTERVALS_RUN,
  RUN_ATTEMPTS,
  LEARNING_LEDGER,
  LEARNING_LEDGER_AGENT,
  LEARNING_SPEND,
  LEARNING_SPEND_AGENT,
  LEARNING_SPEND_OF_RUN,

  // An agent's saved browser sign-ins (design 2.1, the browser sign-in rules): one live row per agent and browser provider, its
  // pointer (the vendor's context or profile id) sealed with the store's one rule (store/seal.ts, AAD
  // sign_ins|<agent>:<provider>|pointer), which the store never opens. The owner sees its name ("default") and saved_at,
  // never the pointer, and no run's tools ever do. Forgetting a sign-in moves its sealed pointer, byte for byte so it
  // still opens, into a tombstone row (sign_in_tombstones), kept only so a server started later can still cut it from
  // what a run it was handed shows and from what its agent learned; every one is kept, never pruned.
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
  // none for a learning dropped before it was proposed). One row a round: a run's first end is round 1, and each end
  // after a follow-up opened it again is the next. Read by the learning routes (the pre-merge view), by the learning run,
  // and by the reader of a run's learning end (store-reads/learning.ts), which reads the newest round.
  `CREATE TABLE IF NOT EXISTS learning_proposals (
    run_id TEXT NOT NULL REFERENCES runs (id),
    round INTEGER NOT NULL CHECK (round >= 1),
    agent_id TEXT NOT NULL REFERENCES agents (id),
    ${json("turn")},
    ${json("proposal")},
    learning_run_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, round)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS learning_proposals_by_agent ON learning_proposals (agent_id, created_at DESC)`,
  ...RUN_LISTING_DDL,
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
