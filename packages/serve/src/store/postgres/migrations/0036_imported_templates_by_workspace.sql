-- runners: unaffected (imported_templates)
-- The store's schema on Postgres, version 36: each imported template package keyed by its workspace and id, as
-- store/schema.ts keeps them on SQLite (IMPORTED_TEMPLATES_KEYS), so each workspace's package name is its own. Applied
-- once, after 0035, inside the transaction migrate.ts opens. Never edit this file once applied: a change is a new file.
-- No runner reads or writes imported_templates, so a runner of an earlier build keeps running on the schema this leaves,
-- and the runner floor stays. A server of an earlier build, whose import names the key on the id alone, refuses the
-- schema (past its version).
--
-- Every row keeps the workspace 0033 gave it: one imported in a workspace is keyed in it, and one of none stays among
-- those of none, still one package an id there. Made only where missing, so a store whose record of this file was lost
-- applies it again unharmed.

CREATE UNIQUE INDEX IF NOT EXISTS imported_templates_in_workspace ON imported_templates (workspace, id) WHERE workspace IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS imported_templates_of_none ON imported_templates (id) WHERE workspace IS NULL;

ALTER TABLE imported_templates DROP CONSTRAINT IF EXISTS imported_templates_pkey;

ALTER TABLE imported_templates ALTER COLUMN id SET NOT NULL;

UPDATE store_meta SET schema_version = 36 WHERE singleton = 1;
