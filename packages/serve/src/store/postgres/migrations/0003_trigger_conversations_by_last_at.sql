-- The store's schema on Postgres, version 3: a trigger's conversations indexed by their last write, as store/schema.ts
-- keeps them on SQLite (its version 6). Applied once, after 0002, inside the transaction migrate.ts opens. Never edit this
-- file once applied: a change is a new file.
--
-- trigger_conversations_by_last_at: a trigger's prune (pruneConversations) reads its oldest conversations and the newest
-- it keeps in one DELETE on this index.

CREATE INDEX trigger_conversations_by_last_at ON trigger_conversations (trigger_id, last_at);

UPDATE store_meta SET schema_version = 3 WHERE singleton = 1;
