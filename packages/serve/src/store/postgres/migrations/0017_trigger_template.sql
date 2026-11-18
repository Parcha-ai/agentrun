-- A trigger's package mark (triggers.template_id, as store/schema.ts keeps it on SQLite: TRIGGERS_TEMPLATE_ID): the id of
-- the template package whose apply made or last kept the trigger, null for one a person made, so a trigger made before
-- reads as no package's. A template update removes only triggers marked with its own package. Applied once, after the
-- migration before it, inside the transaction migrate.ts opens. Never edit this file once applied: a change is a new file.
ALTER TABLE triggers ADD COLUMN IF NOT EXISTS template_id TEXT COLLATE "C";
UPDATE store_meta SET schema_version = 17 WHERE singleton = 1;
