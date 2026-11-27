-- runners: breaking
-- The store's schema on Postgres, version 34: store_meta's mark that every run a follow-up opened again has its ledger
-- row under this build's split (STORE_META_LEDGER_RERECORDED), and the schema version each runner's build knows on its
-- row (runners.knows), as store/schema.ts keeps them on SQLite (version 18). Applied once, after 0033, inside the
-- transaction migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- A run whose learning kept more than one round has its job at its row less every round's look-back (learn/ledger.ts
-- roundsLooked: a follow-up's turns are the job's); a build before wrote its row with the job at its first round's
-- figure and the follow-up as look-back, while its tools_usd and usage lines are now read from its journal under the new
-- split. The mark starts at 0, so the server's next open records each such row again from its run and rounds
-- (run-patch.ts backfillLedger, a page of runs a transaction). A runner of an earlier build still writes such a row under
-- the split before at a run's end, after that pass, so the floor rises to 34, and until its floor read stops it, it ends
-- the runs it holds. Its row says no version it knows (knows null, every row here now), and every claim it holds was taken
-- before the server's open and 30 s: while such a row is there or such a claim held at a pass's start, the server leaves
-- the mark unset and records those runs again every 30 s, and it sets the mark after the first pass that started with
-- neither.
--
-- Added only where missing, so a store whose record of this file was lost applies it again unharmed.

ALTER TABLE store_meta ADD COLUMN IF NOT EXISTS ledger_rerecorded BIGINT NOT NULL DEFAULT 0 CHECK (ledger_rerecorded IN (0, 1));

ALTER TABLE runners ADD COLUMN IF NOT EXISTS knows INTEGER;

UPDATE store_meta SET schema_version = 34 WHERE singleton = 1;
