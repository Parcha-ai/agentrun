-- The store's schema on Postgres, version 15: a hosted machine's minted token (a dial provider's create,
-- spec/computer/attach.md), as store/schema.ts keeps it on SQLite (MINTED_TOKENS). Applied once, after 0014, inside the
-- transaction migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- minted_tokens: one row per machine (its name, from its create's request id); the token's SHA-256 alone is kept (hex),
-- with what the machine must say it is at hello (kind, os, arch), when the token ends (expires_at, the machine's backstop)
-- and when it was revoked (its delete). The table is made only where it is missing, so a store whose record of this file
-- was lost applies it again unharmed.

CREATE TABLE IF NOT EXISTS minted_tokens (
  machine TEXT COLLATE "C" PRIMARY KEY,
  token_sha256 TEXT COLLATE "C" NOT NULL UNIQUE,
  kind TEXT COLLATE "C" NOT NULL,
  os TEXT COLLATE "C" NOT NULL,
  arch TEXT COLLATE "C" NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL
);

UPDATE store_meta SET schema_version = 15 WHERE singleton = 1;
