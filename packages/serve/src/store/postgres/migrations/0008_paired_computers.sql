-- The store's schema on Postgres, version 8: a person's own computer paired with this server (spec/computer/attach.md),
-- and the codes that pair one, as store/schema.ts keeps them on SQLite (version 10). Applied once, after 0007, inside the transaction
-- migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- paired_computers: the token's SHA-256 alone is kept (hex); revoked_at marks a removed computer, whose token dials no more.
-- pairing_codes: a code's SHA-256 alone (hex), good once until expires_at; a used one is deleted as it pairs. Its id names
-- the pairing and is kept on the computer it made (paired_computers.pairing_id), so the console that made the code can
-- tell its own code was used, and by which computer.
-- Each table is made only where it is missing, so a store whose record of this file was lost applies it again unharmed.

CREATE TABLE IF NOT EXISTS paired_computers (
  id TEXT COLLATE "C" PRIMARY KEY,
  name TEXT COLLATE "C" NOT NULL,
  hello TEXT COLLATE "C" NOT NULL CHECK (hello::json IS NOT NULL),
  driver TEXT COLLATE "C" NOT NULL,
  labels TEXT COLLATE "C" NOT NULL CHECK (labels::json IS NOT NULL),
  token_sha256 TEXT COLLATE "C" NOT NULL UNIQUE,
  pairing_id TEXT COLLATE "C" NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  seen_at BIGINT,
  revoked_at BIGINT
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT COLLATE "C" NOT NULL UNIQUE,
  code_sha256 TEXT COLLATE "C" PRIMARY KEY,
  expires_at BIGINT NOT NULL
);

UPDATE store_meta SET schema_version = 8 WHERE singleton = 1;
