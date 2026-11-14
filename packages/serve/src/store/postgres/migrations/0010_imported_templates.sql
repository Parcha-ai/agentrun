-- The store's schema on Postgres, version 10: the template packages imported from GitHub (POST /v2/templates/import), as
-- store/schema.ts keeps them on SQLite (IMPORTED_TEMPLATES). Applied once, after 0009, inside the transaction
-- migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- imported_templates: one row per package id (github:<owner>/<repo>[/<path>]); files is a JSON object of path to base64,
-- the package's files as read. The table is made only where it is missing, so a store whose record of this file was lost
-- applies it again unharmed.

CREATE TABLE IF NOT EXISTS imported_templates (
  id TEXT COLLATE "C" PRIMARY KEY,
  source TEXT COLLATE "C" NOT NULL,
  sha TEXT COLLATE "C" NOT NULL,
  publisher TEXT COLLATE "C" NOT NULL,
  files TEXT COLLATE "C" NOT NULL CHECK (files::json IS NOT NULL),
  imported_at BIGINT NOT NULL
);

UPDATE store_meta SET schema_version = 10 WHERE singleton = 1;
