-- The store's schema on Postgres, version 2: an agent another system owns, run inline (POST /runs), as store/schema.ts
-- keeps it on SQLite. Applied once, after 0001, inside the transaction migrate.ts opens. Never edit this file once
-- applied: a change is a new file.
--
-- agents.external_ref: the agent's reference in the system that owns it, "<source>:<kind>:<id>"; one agent per reference.
-- revisions.external_version: the version there a revision maps; one revision per version of an agent.

ALTER TABLE agents ADD COLUMN external_ref TEXT COLLATE "C";
CREATE UNIQUE INDEX agents_external ON agents (external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE revisions ADD COLUMN external_version TEXT COLLATE "C";
CREATE UNIQUE INDEX revisions_external_version ON revisions (agent_id, external_version) WHERE external_version IS NOT NULL;

UPDATE store_meta SET schema_version = 2 WHERE singleton = 1;
