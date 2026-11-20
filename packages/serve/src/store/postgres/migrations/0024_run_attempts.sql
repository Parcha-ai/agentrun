-- The store's schema on Postgres, version 24: each claim of a run, with the turn it works and its attempt at it, as
-- store/schema.ts keeps it on SQLite (RUN_ATTEMPTS). Applied once, after 0023, inside the transaction migrate.ts opens.
-- Never edit this file once applied: a change is a new file. Additive: a runner of version 23 never reads it, and a claim
-- it makes has no row.
--
-- run_attempts: one row per claim (run_id, epoch), written in the claim's own transaction: the turn it works and its
-- attempt at it, why the attempt before was cut (cause: drain, crash, lease_lapse, retry; null on a turn's first), why
-- this claim let the run go unfinished (cut, written by its release or its runner's lost lease), its runner, the run's
-- state it took the run from, the first journal entry id it could write and when it claimed. Data only: the usage read
-- splits a run's cost by it. Made only where missing, so a store whose record of this file was lost applies it again
-- unharmed.

CREATE TABLE IF NOT EXISTS run_attempts (
  run_id TEXT COLLATE "C" NOT NULL,
  epoch BIGINT NOT NULL,
  turn BIGINT NOT NULL CHECK (turn >= 1),
  attempt BIGINT NOT NULL CHECK (attempt >= 1),
  cause TEXT COLLATE "C" CHECK (cause IS NULL OR cause IN ('drain', 'crash', 'lease_lapse', 'retry')),
  cut TEXT COLLATE "C" CHECK (cut IS NULL OR cut IN ('drain', 'lease_lapse', 'retry')),
  runner TEXT COLLATE "C" NOT NULL,
  from_state TEXT COLLATE "C" NOT NULL,
  journal_from BIGINT NOT NULL,
  claimed_at BIGINT NOT NULL,
  PRIMARY KEY (run_id, epoch)
);

UPDATE store_meta SET schema_version = 24 WHERE singleton = 1;
