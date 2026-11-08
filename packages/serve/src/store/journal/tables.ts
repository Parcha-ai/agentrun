// Every run's journal in the one store: pi-durable's tables (its SqliteStorage schema, version 2, the `sleeping` task
// status included), each keyed (run_id, …) and each index with run_id leading, so one run's scans read only its rows and
// two runs never share an id, a seq or a document address. store/schema.ts places these after the runs table.
// pi-durable's own SQLite schema is MIT licensed (see NOTICE).

/** The journal's tables and indexes, in creation order. */
export const JOURNAL_TABLES = {
  metadata: "pi_metadata",
  recordIds: "pi_record_ids",
  conversations: "pi_conversations",
  entries: "pi_entries",
  tasks: "pi_tasks",
  submissions: "pi_submissions",
  documents: "pi_documents",
  documentRevisions: "pi_document_revisions",
} as const;

const T = JOURNAL_TABLES;

/** The journal's DDL: each table keyed by run_id first, each index run_id-first. Idempotent (IF NOT EXISTS). */
export function journalTables(): string {
  return PI_DDL.join(";\n") + ";\n";
}

/** The journal's DDL, one statement each, for the store's schema (store/schema.ts) to run after its own. */
export const PI_DDL: readonly string[] = Object.freeze([
    // One row per run: the run's own id and seq namespaces. next_id is TEXT, as pi's: node:sqlite rejects INTEGER
    // results outside JavaScript's safe range.
    `CREATE TABLE IF NOT EXISTS ${T.metadata} (
      run_id TEXT PRIMARY KEY,
      next_id TEXT NOT NULL,
      next_seq INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS ${T.recordIds} (
      run_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document')),
      PRIMARY KEY (run_id, id)
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS ${T.conversations} (
      run_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      owner_conversation_id INTEGER,
      owner_task_id INTEGER,
      record TEXT NOT NULL CHECK (json_valid(record)),
      PRIMARY KEY (run_id, id)
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS pi_conversations_by_owner_conversation ON ${T.conversations} (run_id, owner_conversation_id, id)`,
    `CREATE INDEX IF NOT EXISTS pi_conversations_by_owner_task ON ${T.conversations} (run_id, owner_task_id, id)`,
    `CREATE TABLE IF NOT EXISTS ${T.entries} (
      run_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      head INTEGER,
      commit_seq INTEGER NOT NULL,
      record TEXT NOT NULL CHECK (json_valid(record)),
      PRIMARY KEY (run_id, id)
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS pi_entries_by_conversation ON ${T.entries} (run_id, conversation_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS pi_entry_heads_by_conversation ON ${T.entries} (run_id, conversation_id, id DESC) WHERE head IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${T.tasks} (
      run_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
      abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
      background INTEGER NOT NULL CHECK (background IN (0, 1)),
      record TEXT NOT NULL CHECK (json_valid(record)),
      PRIMARY KEY (run_id, id)
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS pi_tasks_by_status ON ${T.tasks} (run_id, status, id)`,
    `CREATE INDEX IF NOT EXISTS pi_tasks_by_conversation ON ${T.tasks} (run_id, conversation_id, id)`,
    `CREATE INDEX IF NOT EXISTS pi_tasks_by_kind ON ${T.tasks} (run_id, kind, id)`,
    `CREATE INDEX IF NOT EXISTS pi_tasks_by_abort_requested ON ${T.tasks} (run_id, abort_requested, id)`,
    `CREATE INDEX IF NOT EXISTS pi_tasks_by_background ON ${T.tasks} (run_id, background, id)`,
    `CREATE TABLE IF NOT EXISTS ${T.submissions} (
      run_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      request_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
      record TEXT NOT NULL CHECK (json_valid(record)),
      PRIMARY KEY (run_id, id)
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS pi_submissions_by_request ON ${T.submissions} (run_id, conversation_id, request_id)`,
    `CREATE INDEX IF NOT EXISTS pi_submissions_by_conversation ON ${T.submissions} (run_id, conversation_id, id)`,
    `CREATE INDEX IF NOT EXISTS pi_submissions_by_status ON ${T.submissions} (run_id, status, id)`,
    `CREATE TABLE IF NOT EXISTS ${T.documents} (
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
      ON ${T.documents} (run_id, kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
    `CREATE INDEX IF NOT EXISTS pi_documents_by_scope ON ${T.documents} (run_id, scope_kind, owner_id, id)`,
    `CREATE INDEX IF NOT EXISTS pi_documents_by_scope_kind ON ${T.documents} (run_id, scope_kind, owner_id, kind, id)`,
    `CREATE TABLE IF NOT EXISTS ${T.documentRevisions} (
      run_id TEXT NOT NULL,
      document_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
      version INTEGER NOT NULL,
      content TEXT NOT NULL CHECK (json_valid(content)),
      PRIMARY KEY (run_id, document_id, seq)
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS pi_document_revisions_by_kind ON ${T.documentRevisions} (run_id, document_id, kind, seq DESC)`,
]);
