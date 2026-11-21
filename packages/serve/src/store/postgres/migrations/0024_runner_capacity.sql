-- The store's schema on Postgres, version 24: what each runner says of itself and each hand-back, for the server's
-- capacity read (GET /v2/capacity, capacity.ts), as store/schema.ts keeps them on SQLite (RUNNERS_ADDED, HAND_BACKS).
-- Applied once, after 0023, inside the transaction migrate.ts opens. Never edit this file once applied: a change is a new
-- file. Additive: a runner of an earlier build that is already running writes its row as before, its version and slots
-- read as unknown (null). A runner of an earlier build that starts after this file is applied refuses the store
-- (openPostgresStore: the schema is newer than it knows), so Postgres runners are upgraded with the server.
--
-- runners.version: the runner's build (the serve package's version); null on a row an earlier build wrote.
-- runners.slots: the most runs the runner holds at once (its loops); null on a row an earlier build wrote.
-- hand_backs: one row per release that left its run running (a runner's drain, a loop that closed itself, a claim given
-- back): the run, the runner that let it go, the epoch it let go of and when, on the database's clock. Counts and ids only,
-- kept 24 hours (the release that writes one removes the older rows), indexed by time (the window, the prune) and by
-- run (a run's purge and delete). Each piece is made only where missing, so a store
-- whose record of this file was lost applies it again unharmed.

ALTER TABLE runners ADD COLUMN IF NOT EXISTS version TEXT COLLATE "C";
ALTER TABLE runners ADD COLUMN IF NOT EXISTS slots INTEGER;

CREATE TABLE IF NOT EXISTS hand_backs (
  run_id TEXT COLLATE "C" NOT NULL,
  runner TEXT COLLATE "C" NOT NULL,
  epoch BIGINT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS hand_backs_at ON hand_backs (at);
CREATE INDEX IF NOT EXISTS hand_backs_run ON hand_backs (run_id);

UPDATE store_meta SET schema_version = 24 WHERE singleton = 1;
