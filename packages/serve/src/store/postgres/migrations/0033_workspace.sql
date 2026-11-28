-- The store's schema on Postgres, version 33: each agent's, run's and imported template package's workspace, as
-- store/schema.ts keeps them on SQLite (WORKSPACE_ADDED). Applied once, after 0032, inside the transaction migrate.ts
-- opens. Never edit this file once applied: a change is a new file. Additive: every column is nullable and no runner reads
-- or writes it, so a runner of an earlier build keeps running on the schema this leaves.
--
-- workspace: the opaque name of the workspace a scoped request (the AgentRun-Workspace header, workspace-scope.ts) made the
-- row in; null for a row made unscoped, every row before this file. A run with none reads as its agent's. Added only where
-- missing, so a store whose record of this file was lost applies it again unharmed.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS workspace TEXT COLLATE "C";
ALTER TABLE runs ADD COLUMN IF NOT EXISTS workspace TEXT COLLATE "C";
ALTER TABLE imported_templates ADD COLUMN IF NOT EXISTS workspace TEXT COLLATE "C";
CREATE INDEX IF NOT EXISTS agents_by_workspace ON agents (workspace, created_at);
CREATE INDEX IF NOT EXISTS runs_by_workspace ON runs (workspace, started_at);

UPDATE store_meta SET schema_version = 33 WHERE singleton = 1;
