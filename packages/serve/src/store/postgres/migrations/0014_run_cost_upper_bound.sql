-- Version 14: whether a run's stored cost is the most it can have cost (runs.cost_upper_bound, as store/schema.ts keeps it
-- on SQLite): 1 when it counts a request cut with no answer at what its cap held for it, written in the end's commit with
-- cost_usd; 0 otherwise, an unknown cost's included. A run ended before reads 0. Applied once, after 0013, inside the
-- transaction migrate.ts opens. Never edit this file once applied: a change is a new file.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cost_upper_bound BIGINT NOT NULL DEFAULT 0 CHECK (cost_upper_bound IN (0, 1));
UPDATE store_meta SET schema_version = 14 WHERE singleton = 1;
