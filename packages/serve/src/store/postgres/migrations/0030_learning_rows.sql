-- The store's schema on Postgres, version 30: each agent's learning as versioned rows, as store/schema.ts keeps it on
-- SQLite (LEARNING_ROWS). Applied once, after 0029, inside the transaction migrate.ts opens. Never edit this file once
-- applied: a change is a new file. Additive: no table or column an earlier build reads changes.
--
-- learning_saves: each save of an agent's learning, one version, its random id (what a run's seed and the log name),
-- its kind (init, run, person, purged), who saved it and why (`change`), and a run's merge key (one merge a run's
-- round). A purged run's save keeps its version, id and merge key and loses its words.
-- learning_items: each item's versions, never updated by a save: a note (one line of corrections.md, `pos` its place)
-- or a workflow (its files as one JSON object, `digest` its workflow.json's, `writers` each file's writing run). The
-- item at a version is its newest row at or before it; a null body is gone. `by_run`: a note's run, a workflow's
-- workflow.json's writer. A run's purge deletes its notes and takes each workflow file it wrote back to its text before.
-- learning_records: the agent's promotion records, grades and audit rows, each its data whole; its run, workflow and
-- digest read out for a purge.
-- Made only where missing, so a store whose record of this file was lost applies it again unharmed.

CREATE TABLE IF NOT EXISTS learning_saves (
  agent_id TEXT COLLATE "C" NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  id TEXT COLLATE "C" NOT NULL,
  at BIGINT NOT NULL,
  kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('init', 'run', 'person', 'purged')),
  by_run TEXT COLLATE "C",
  merge_key TEXT COLLATE "C",
  change TEXT COLLATE "C" NOT NULL CHECK (change::json IS NOT NULL),
  PRIMARY KEY (agent_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS learning_saves_id ON learning_saves (agent_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS learning_saves_merge ON learning_saves (agent_id, merge_key);
CREATE INDEX IF NOT EXISTS learning_saves_run ON learning_saves (by_run);

CREATE TABLE IF NOT EXISTS learning_items (
  agent_id TEXT COLLATE "C" NOT NULL,
  kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('note', 'workflow')),
  name TEXT COLLATE "C" NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  body TEXT COLLATE "C",
  by_run TEXT COLLATE "C",
  change TEXT COLLATE "C" NOT NULL,
  person BIGINT NOT NULL,
  pos BIGINT NOT NULL,
  digest TEXT COLLATE "C",
  writers TEXT COLLATE "C" CHECK (writers IS NULL OR writers::json IS NOT NULL),
  at BIGINT NOT NULL,
  PRIMARY KEY (agent_id, kind, name, version)
);
CREATE INDEX IF NOT EXISTS learning_items_version ON learning_items (agent_id, version);
CREATE INDEX IF NOT EXISTS learning_items_run ON learning_items (by_run);

CREATE TABLE IF NOT EXISTS learning_records (
  agent_id TEXT COLLATE "C" NOT NULL,
  kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('promotion', 'grade', 'audit')),
  seq BIGINT NOT NULL,
  run_id TEXT COLLATE "C",
  workflow TEXT COLLATE "C",
  digest TEXT COLLATE "C",
  data TEXT COLLATE "C" NOT NULL CHECK (data::json IS NOT NULL),
  at BIGINT NOT NULL,
  PRIMARY KEY (agent_id, kind, seq)
);
CREATE INDEX IF NOT EXISTS learning_records_run ON learning_records (run_id);

UPDATE store_meta SET schema_version = 30 WHERE singleton = 1;
