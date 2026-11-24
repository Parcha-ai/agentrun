-- The store's schema on Postgres, version 27: the learning ledger (learn/ledger.ts), as store/schema.ts keeps it on
-- SQLite (LEARNING_LEDGER, LEARNING_SPEND). Applied once, after 0026, inside the transaction migrate.ts opens. Never edit
-- this file once applied: a change is a new file. Additive: a runner of version 26 never writes it; a run it ends has no
-- row, or a row for an earlier end (`at` is the run's ended_at it was written for), and the reader records it from the
-- run's row as it reads either way (store-reads/learning.ts).
--
-- learning_ledger: one row a run, written by each patch that leaves the run ended (run-patch.ts applyRunPatch, in that
-- patch's transaction): who answered it (path, null when its end named none), the revision that ran it, why it was not
-- served alone, the job's own $ and its rounds' look-back, and whether its cost is known. Gone with its run's purge.
-- learning_spend: each learning cost by the revision it is for (a compile turn by its round, a check's replay run, an
-- audit's shadow run with the run it audits), written with its run's ledger row. Figures only, no run text. Made only
-- where missing, so a store whose record of this file was lost applies it again unharmed.

CREATE TABLE IF NOT EXISTS learning_ledger (
  run_id TEXT COLLATE "C" PRIMARY KEY,
  agent_id TEXT COLLATE "C" NOT NULL,
  started_at BIGINT NOT NULL,
  path TEXT COLLATE "C" CHECK (path IS NULL OR path IN ('agent', 'handed_back', 'workflow', 'replay', 'audit')),
  workflow TEXT COLLATE "C",
  digest TEXT COLLATE "C",
  not_served TEXT COLLATE "C" CHECK (not_served IS NULL OR not_served IN ('cost_stop', 'cut')),
  job_usd DOUBLE PRECISION,
  look_back_usd DOUBLE PRECISION,
  cost TEXT COLLATE "C" NOT NULL CHECK (cost IN ('known', 'unknown', 'at_most')),
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS learning_ledger_agent ON learning_ledger (agent_id);

CREATE TABLE IF NOT EXISTS learning_spend (
  run_id TEXT COLLATE "C" NOT NULL,
  kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('compile', 'check', 'audit')),
  round BIGINT NOT NULL CHECK (round >= 0),
  agent_id TEXT COLLATE "C" NOT NULL,
  of_run TEXT COLLATE "C",
  workflow TEXT COLLATE "C",
  digest TEXT COLLATE "C",
  usd DOUBLE PRECISION,
  at BIGINT NOT NULL,
  PRIMARY KEY (run_id, kind, round)
);
CREATE INDEX IF NOT EXISTS learning_spend_agent ON learning_spend (agent_id);
CREATE INDEX IF NOT EXISTS learning_spend_of_run ON learning_spend (of_run) WHERE of_run IS NOT NULL;

UPDATE store_meta SET schema_version = 27 WHERE singleton = 1;
