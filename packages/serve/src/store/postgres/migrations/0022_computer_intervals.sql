-- The store's schema on Postgres, version 22: each computer a run made, from its create to its proven delete, as
-- store/schema.ts keeps it on SQLite (COMPUTER_INTERVALS). Applied once, after 0021, inside the transaction migrate.ts
-- opens. Never edit this file once applied: a change is a new file.
--
-- computer_intervals: one row per computer a run's claim made through its provider (a sandbox, a desktop, a phone), by the
-- provider's own id for it; what its create asked for (kind, GPU, CPUs, memory; null where it asked none), when it was
-- made, whether the run's park kept it past its claim (kept, 0 or 1), and ended_at, written only when the provider's
-- delete of it answered ok (null while none did). A computer made before this file has no row. The table and its index are
-- made only where missing, so a store whose record of this file was lost applies it again unharmed.

CREATE TABLE IF NOT EXISTS computer_intervals (
  provider TEXT COLLATE "C" NOT NULL,
  provider_id TEXT COLLATE "C" NOT NULL,
  run_id TEXT COLLATE "C" NOT NULL,
  kind TEXT COLLATE "C",
  gpu_type TEXT COLLATE "C",
  gpu_count BIGINT,
  cpus DOUBLE PRECISION,
  memory_mb BIGINT,
  started_at BIGINT NOT NULL,
  kept BIGINT NOT NULL DEFAULT 0 CHECK (kept IN (0, 1)),
  ended_at BIGINT,
  PRIMARY KEY (provider, provider_id)
);
CREATE INDEX IF NOT EXISTS computer_intervals_run ON computer_intervals (run_id, started_at);

UPDATE store_meta SET schema_version = 22 WHERE singleton = 1;
