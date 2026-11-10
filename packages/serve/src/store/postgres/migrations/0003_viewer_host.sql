-- The store's schema on Postgres, version 3: where a live viewer answers when its runner is on another host than the
-- server (live-reach.ts), as store/schema.ts keeps it on SQLite. Applied once, after 0002, inside the transaction
-- migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- computer_viewers.host: the runner's live host (AGENTRUN_RUNNER_LIVE_HOST); null, the server's own machine (loopback).

ALTER TABLE computer_viewers ADD COLUMN host TEXT COLLATE "C";

UPDATE store_meta SET schema_version = 3 WHERE singleton = 1;
