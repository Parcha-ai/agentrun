-- The store's schema on Postgres, version 35: what the launch hook told the host of a firing's run
-- (trigger_firings.hooked, FiringRow.hooked), as store/schema.ts keeps it on SQLite (TRIGGER_FIRINGS_HOOKED). Applied
-- once, after 0034, inside the transaction migrate.ts opens. Never edit this file once applied: a change is a new file.
-- Additive: the column is nullable and no runner reads or writes it, so a runner of an earlier build keeps running on
-- the schema this leaves.
--
-- hooked: {"max_cost_usd": number | null}, written at the firing's first hand and kept, so a retry names the same cap and
-- the host's start for the firing runs under it; null for a firing never handed, every firing before this file. Added
-- only where missing, so a store whose record of this file was lost applies it again unharmed.
ALTER TABLE trigger_firings ADD COLUMN IF NOT EXISTS hooked TEXT COLLATE "C" CHECK (hooked IS NULL OR hooked::json IS NOT NULL);

UPDATE store_meta SET schema_version = 35 WHERE singleton = 1;
