-- The store's schema on Postgres, version 20: each runner's word that it is there (runner/presence.ts), as store/schema.ts
-- keeps it on SQLite (RUNNERS). Applied once, after 0019, inside the transaction migrate.ts opens.
-- Never edit this file once applied: a change is a new file.
--
-- runners: one row per runner, beside a server or in a process of its own: its name, its incarnation (its process since
-- its start), why it refused to claim any run (`refused`, its words; null for a runner that claims) and when it last said
-- it was there. The server reads them for whether any runner here can take a run.
-- IF NOT EXISTS: applied again over a store that has it, it changes nothing.

CREATE TABLE IF NOT EXISTS runners (
  runner TEXT COLLATE "C" PRIMARY KEY,
  incarnation TEXT COLLATE "C" NOT NULL,
  refused TEXT,
  seen_at BIGINT NOT NULL
);

UPDATE store_meta SET schema_version = 20 WHERE singleton = 1;
