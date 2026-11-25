-- The store's schema on Postgres, version 30: learning_ledger without its `epoch`, as store/schema.ts keeps it on SQLite
-- (LEARNING_LEDGER). Applied once, after 0029, inside the transaction migrate.ts opens. Never edit this file once applied:
-- a change is a new file.
-- runners: breaking
--
-- A row said the end it was written for (the run's epoch then) so a reader could find one an earlier build left stale and
-- record it again on every read. The server now records each ended run with no row once, at its open, and every end,
-- heal and import writes its row in its own transaction: no reader checks a row against its run. A runner of an earlier
-- version writes `epoch` in each end's insert and fails on the schema this leaves, so the floor rises to 30: stop the earlier
-- build's runners before this build's server starts.

ALTER TABLE learning_ledger DROP COLUMN IF EXISTS epoch;

UPDATE store_meta SET schema_version = 30 WHERE singleton = 1;
