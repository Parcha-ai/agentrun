-- The store's schema on Postgres, version 5: a run's learning is kept by round, as store/schema.ts keeps it on SQLite
-- (version 7). A run's first end is round 1; each end after a follow-up opened the run again looks back once more, a
-- round of its own, beside the rounds before it. Applied once, after 0004, inside the transaction migrate.ts opens. Never
-- edit this file once applied: a change is a new file.
--
-- learning_proposals_pkey is Postgres's name for 0001's primary key on run_id.
-- Safe to apply again (a store whose later migrations are unrecorded re-applies them from the first one it cannot vouch for): every statement here is idempotent.

ALTER TABLE learning_proposals ADD COLUMN IF NOT EXISTS round BIGINT NOT NULL DEFAULT 1 CHECK (round >= 1);
ALTER TABLE learning_proposals ALTER COLUMN round DROP DEFAULT;
ALTER TABLE learning_proposals DROP CONSTRAINT IF EXISTS learning_proposals_pkey;
ALTER TABLE learning_proposals ADD PRIMARY KEY (run_id, round);

UPDATE store_meta SET schema_version = 5 WHERE singleton = 1;
