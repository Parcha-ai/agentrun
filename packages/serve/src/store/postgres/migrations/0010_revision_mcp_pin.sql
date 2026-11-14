-- The store's schema on Postgres, version 10: an agent's MCP tools are pinned on its revision when it is saved
-- (revisions.mcp_pin), as store/schema.ts keeps them on SQLite (where a server open adds the column), in place of each
-- run's pin at its first claim (mcp_pins, dropped: a run reads its revision's). Applied once, after 0009, inside the
-- transaction migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- mcp_pin: JSON text, per granted server its URL then, the granted tools as it listed them and their prices; NULL for a
-- revision that grants no MCP tool.

ALTER TABLE revisions ADD COLUMN IF NOT EXISTS mcp_pin TEXT COLLATE "C" CHECK (mcp_pin IS NULL OR mcp_pin::json IS NOT NULL);

DROP TABLE IF EXISTS mcp_pins;

UPDATE store_meta SET schema_version = 10 WHERE singleton = 1;
