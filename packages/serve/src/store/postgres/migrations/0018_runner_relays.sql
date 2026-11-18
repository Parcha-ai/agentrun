-- The store's schema on Postgres, version 18: a dial relayed to the runner that made its machine (dial-relay.ts), as
-- store/schema.ts keeps it on SQLite (version 13). Applied once, after 0017, inside the transaction migrate.ts opens.
-- Never edit this file once applied: a change is a new file.
--
-- minted_tokens.runner, .incarnation: the runner in a process of its own that minted the machine's token, and its
-- incarnation (its process since its start); null for a token the server's own process minted.
-- minted_tokens.run: the run the machine works for, as its create named it, which the words about its dial say; null for
-- a machine of no run.
-- minted_tokens.refused: why the server refused to relay the machine's dial, in its 503's words (never the token), which
-- the minting runner's create reads to end its wait; null while none was, and again at a mint.
-- runner_relays: one row per runner in a process of its own, where its attach listener takes the dials the server relays
-- to it (its host and port), under its incarnation, and when it last said it was there.
-- IF NOT EXISTS: applied again over a store that has them, it changes nothing.

ALTER TABLE minted_tokens ADD COLUMN IF NOT EXISTS runner TEXT COLLATE "C";
ALTER TABLE minted_tokens ADD COLUMN IF NOT EXISTS incarnation TEXT COLLATE "C";
ALTER TABLE minted_tokens ADD COLUMN IF NOT EXISTS run TEXT COLLATE "C";
ALTER TABLE minted_tokens ADD COLUMN IF NOT EXISTS refused TEXT;

CREATE TABLE IF NOT EXISTS runner_relays (
  runner TEXT COLLATE "C" PRIMARY KEY,
  incarnation TEXT COLLATE "C" NOT NULL,
  host TEXT COLLATE "C" NOT NULL,
  port INTEGER NOT NULL,
  seen_at BIGINT NOT NULL
);

UPDATE store_meta SET schema_version = 18 WHERE singleton = 1;
