-- The store's schema on Postgres, version 21: when a run or an agent was purged, as store/schema.ts keeps it on SQLite
-- (runs.purged_at, agents.purged_at). Applied once, after 0020, inside the transaction migrate.ts opens. Never edit this
-- file once applied: a change is a new file.
--
-- A purged run (DELETE /v2/runs/{id}) keeps its row as a tombstone: its id, agent, state, times and cost, every record of
-- what it was given or did gone, so every total that summed its cost sums it still. A purged agent (DELETE
-- /v2/agents/{id} of an archived agent made here) keeps its row the same way, its name, description and revisions'
-- content blanked. Null: not purged. In place: every row reads as not purged.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS purged_at BIGINT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS purged_at BIGINT;

UPDATE store_meta SET schema_version = 21 WHERE singleton = 1;
