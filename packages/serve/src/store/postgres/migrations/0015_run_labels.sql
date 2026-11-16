-- Version 15: a run's labels (runs.labels, as store/schema.ts keeps them on SQLite): the caller's labels, a JSON object of
-- strings set once at the run's start; null when it was given none, so a run started before reads as given none. Applied
-- once, after 0014, inside the transaction migrate.ts opens. Never edit this file once applied: a change is a new file.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS labels TEXT COLLATE "C" CHECK (labels IS NULL OR labels::json IS NOT NULL);
UPDATE store_meta SET schema_version = 15 WHERE singleton = 1;
