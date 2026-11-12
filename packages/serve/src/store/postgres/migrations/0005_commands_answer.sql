-- The store's schema on Postgres, version 5: a command keeps its answer, as store/schema.ts keeps it on SQLite
-- (commands.answer). The runner writes it with the commit that takes the row; the server reads it once and clears it
-- (Store.answerOf). Applied once, after 0004, inside the transaction migrate.ts opens. Never edit this file once applied: a
-- change is a new file.
--
-- answer: JSON text, NULL until a take writes one and again once it is read.

ALTER TABLE commands ADD COLUMN answer TEXT COLLATE "C" CHECK (answer IS NULL OR answer::json IS NOT NULL);

UPDATE store_meta SET schema_version = 5 WHERE singleton = 1;
