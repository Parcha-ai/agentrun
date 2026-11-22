-- The store's schema on Postgres, version 20: each runner's word that it is there (runner/presence.ts) and its relay
-- (dial-relay.ts) in one table, as store/schema.ts keeps it on SQLite (RUNNERS). Applied once, after 0019, inside the
-- transaction migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- runners (runner_relays until now): one row per runner, beside a server or in a process of its own: its name, its
-- incarnation (its process since its start, the one its relay's minted tokens and proofs name), why it refused to claim
-- any run (`refused`, its words; null for a runner that claims), where its relay's attach listener answers (`host` and
-- `port`; null for a runner with no relay) and when it last said it was there. The server reads them for whether any
-- runner here can take a run, and where to relay a dial. In place: every relay's row is kept, refusing nothing, and
-- reads as gone 30 s after its last renewal, as any runner's row does.

ALTER TABLE runner_relays RENAME TO runners;
ALTER TABLE runners RENAME CONSTRAINT runner_relays_pkey TO runners_pkey;
ALTER TABLE runners ALTER COLUMN host DROP NOT NULL;
ALTER TABLE runners ALTER COLUMN port DROP NOT NULL;
ALTER TABLE runners ADD COLUMN refused TEXT;

UPDATE store_meta SET schema_version = 20 WHERE singleton = 1;
