-- The store's schema on Postgres, version 23: a computer's disk and the time its run's claims booked, as store/schema.ts
-- keeps them on SQLite (COMPUTER_INTERVALS). Applied once, after 0022, inside the transaction migrate.ts opens. Never edit
-- this file once applied: a change is a new file.
--
-- computer_intervals.disk_gb: the computer's disk in GB, where its provider said it; null else (never a guess).
-- computer_intervals.booked_ms: how much of the computer's time a claim of its run booked on the run's ledger; the rest
-- of its life is time no claim held (kept for a follow-up, deleted after its run, still running). A row from before this
-- file has none booked. Each column is added only where missing, so a store whose record of this file was lost applies
-- it again unharmed.

ALTER TABLE computer_intervals ADD COLUMN IF NOT EXISTS disk_gb DOUBLE PRECISION;
ALTER TABLE computer_intervals ADD COLUMN IF NOT EXISTS booked_ms BIGINT NOT NULL DEFAULT 0 CHECK (booked_ms >= 0);

UPDATE store_meta SET schema_version = 23 WHERE singleton = 1;
