-- The store's schema on Postgres, version 3: a run's labels, as store/schema.ts keeps them on SQLite. Applied once, after
-- 0002, inside the transaction migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- runs.labels: the caller's labels, a JSON object of strings set once at the run's start; null when it was given none.

ALTER TABLE runs ADD COLUMN labels TEXT COLLATE "C" CHECK (labels IS NULL OR labels::json IS NOT NULL);

UPDATE store_meta SET schema_version = 3 WHERE singleton = 1;
