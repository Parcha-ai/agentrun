-- The store's schema on Postgres, version 30: learning_ledger without its `epoch`, as store/schema.ts keeps it on SQLite
-- (LEARNING_LEDGER), its by-hand index (LEARNING_LEDGER_BY_HAND), and store_meta's mark that every ended run has its row
-- (STORE_META_LEDGER_BACKFILLED). Applied once, after 0029, inside the transaction migrate.ts opens. Never edit this file
-- once applied: a change is a new file.
-- runners: breaking
--
-- A row said the end it was written for (the run's epoch then) so a reader could find one an earlier build left stale and
-- record it again on every read. The server now records each ended run with no row once, at its open (backfillLedger, a
-- page of runs a transaction, then the mark), and every end, heal and import writes its row in its own transaction: no
-- reader checks a row against its run. So the rows that release could leave wrong are deleted first, with their spend
-- rows, for the open's backfill to record again from their runs (schema.ts LEARNING_LEDGER_REPAIR, the same statements):
-- a row whose end named no path (a run by hand left null, a shadow that failed first with no audit spend), one behind its
-- run's epoch, an unknown cost its run has now, and an audit's shadow on another path. The mark starts at 0, so the first
-- open records them. A runner of an earlier version writes `epoch` in each end's insert and fails on the schema this
-- leaves, so the floor rises to 30: stop the earlier build's runners before this build's server starts.

DELETE FROM learning_spend WHERE run_id IN (SELECT l.run_id FROM learning_ledger l JOIN runs ON runs.id = l.run_id
    WHERE l.path IS NULL OR l.epoch <> runs.epoch OR (l.cost = 'unknown' AND runs.cost_usd IS NOT NULL)
      OR (substr(l.run_id, 1, 6) = 'audit.' AND l.path <> 'audit'));

DELETE FROM learning_ledger WHERE run_id IN (SELECT l.run_id FROM learning_ledger l JOIN runs ON runs.id = l.run_id
    WHERE l.path IS NULL OR l.epoch <> runs.epoch OR (l.cost = 'unknown' AND runs.cost_usd IS NOT NULL)
      OR (substr(l.run_id, 1, 6) = 'audit.' AND l.path <> 'audit'));

ALTER TABLE learning_ledger DROP COLUMN epoch;

CREATE INDEX learning_ledger_by_hand ON learning_ledger (agent_id, path, started_at, run_id);

ALTER TABLE store_meta ADD COLUMN ledger_backfilled BIGINT NOT NULL DEFAULT 0 CHECK (ledger_backfilled IN (0, 1));

UPDATE store_meta SET schema_version = 30 WHERE singleton = 1;
