-- The store's schema on Postgres, version 3: one answer per approval, as store/schema.ts COMMANDS_ONE_ANSWER keeps it on
-- SQLite. Applied once, after 0002, inside the transaction migrate.ts opens. Never edit this file once applied: a change is
-- a new file.
--
-- commands_one_answer: an approve or deny naming one approval (the body's `approval`, the tool call's id) is unique per run
-- while the runner has not refused it. The first answer written wins; a second, whether the same answer or the other one,
-- is a unique violation (StoreConstraint), which the server reads back as the first one's decision (the same again
-- changes nothing, the other is 409 already_answered). An answer the runner refused (its run could not resume) holds no
-- place, so the person may answer again.

CREATE UNIQUE INDEX commands_one_answer ON commands (run_id, (body::json ->> 'approval')) WHERE kind IN ('approve', 'deny') AND refused IS NULL;

UPDATE store_meta SET schema_version = 3 WHERE singleton = 1;
