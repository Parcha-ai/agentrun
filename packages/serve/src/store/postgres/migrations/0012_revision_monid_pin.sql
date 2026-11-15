-- Version 12: an agent's monid pin on its revision (revisions.monid_pin, as store/schema.ts), no longer in its body.
-- Applied once, after 0011, inside the transaction migrate.ts opens. Never edit this file once applied.
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS monid_pin TEXT COLLATE "C" CHECK (monid_pin IS NULL OR monid_pin::json IS NOT NULL);
UPDATE store_meta SET schema_version = 12 WHERE singleton = 1;
