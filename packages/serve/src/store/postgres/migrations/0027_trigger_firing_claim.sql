-- Version 27: a firing's claim (trigger_firings.claimed_until and claimed_by, as store/schema.ts keeps them on SQLite:
-- TRIGGER_FIRINGS_CLAIM): the server mid-hand on a firing, by its own id, until a time on the triggers' clock. Other
-- servers count a due firing so claimed as a run in progress, and leave it to the server that holds it; the claim lapses
-- at its time. Both null when none holds it, so every firing already here reads as unclaimed. A runner never reads
-- firings. Applied once, after 0026, inside the transaction migrate.ts opens. Never edit this file once applied: a change
-- is a new file.
ALTER TABLE trigger_firings ADD COLUMN IF NOT EXISTS claimed_until BIGINT;
ALTER TABLE trigger_firings ADD COLUMN IF NOT EXISTS claimed_by TEXT COLLATE "C";
UPDATE store_meta SET schema_version = 27 WHERE singleton = 1;
