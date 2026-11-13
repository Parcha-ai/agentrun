-- The store's schema on Postgres, version 7: where a live viewer answers when its runner is on another host than the
-- server (live-reach.ts), as store/schema.ts keeps it on SQLite (version 9). Applied once, after 0006, inside the transaction
-- migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- computer_viewers.host: the runner's live host (AGENTRUN_RUNNER_LIVE_HOST); null, the server's own machine (loopback).
-- IF NOT EXISTS: applied again over a store that has it (the migration-0003 repair re-runs every migration after 0002),
-- it changes nothing.

ALTER TABLE computer_viewers ADD COLUMN IF NOT EXISTS host TEXT COLLATE "C";

UPDATE store_meta SET schema_version = 7 WHERE singleton = 1;
