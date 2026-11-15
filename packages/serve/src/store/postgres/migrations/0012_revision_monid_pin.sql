-- The store's schema on Postgres, version 12: an agent's monid endpoints are pinned on its revision when it is saved
-- (revisions.monid_pin), beside its MCP tools (mcp_pin), as store/schema.ts keeps them on SQLite (where a server open
-- adds the column), in place of the pin in the revision's body. Applied once, after 0011, inside the transaction
-- migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- monid_pin: JSON text, each granted endpoint by its catalog name, as monid listed it then (description, input, price);
-- NULL for a revision that grants no monid endpoint.

ALTER TABLE revisions ADD COLUMN IF NOT EXISTS monid_pin TEXT COLLATE "C" CHECK (monid_pin IS NULL OR monid_pin::json IS NOT NULL);

UPDATE store_meta SET schema_version = 12 WHERE singleton = 1;
