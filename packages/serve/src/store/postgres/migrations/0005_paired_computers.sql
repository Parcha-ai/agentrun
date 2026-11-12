-- The store's schema on Postgres, version 5: a person's own computer paired with this server (spec/computer/attach.md),
-- and the codes that pair one, as store/schema.ts keeps them on SQLite. Applied once, after 0004, inside the transaction
-- migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- paired_computers: the token's SHA-256 alone is kept (hex); revoked_at marks a removed computer, whose token dials no more.
-- pairing_codes: a code's SHA-256 alone (hex), good once until expires_at; a used one is deleted as it pairs.

CREATE TABLE paired_computers (
  id TEXT COLLATE "C" PRIMARY KEY,
  name TEXT COLLATE "C" NOT NULL,
  hello TEXT COLLATE "C" NOT NULL CHECK (hello::json IS NOT NULL),
  driver TEXT COLLATE "C" NOT NULL,
  labels TEXT COLLATE "C" NOT NULL CHECK (labels::json IS NOT NULL),
  token_sha256 TEXT COLLATE "C" NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  seen_at BIGINT,
  revoked_at BIGINT
);

CREATE TABLE pairing_codes (
  code_sha256 TEXT COLLATE "C" PRIMARY KEY,
  expires_at BIGINT NOT NULL
);

UPDATE store_meta SET schema_version = 5 WHERE singleton = 1;
