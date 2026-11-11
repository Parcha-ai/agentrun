-- The store's schema on Postgres, version 4: a stopped run says which stop it was in its outcome, as store/schema.ts keeps
-- it on SQLite: 'stopped' when a person stopped it (its turn is over, not the run: a message reopens it) or 'cancelled'
-- (over for good), beside an ended run's 'completed' and 'escalated'. Applied once, after 0003, inside the transaction
-- migrate.ts opens. Never edit this file once applied: a change is a new file.
--
-- runs_outcome_check is Postgres's name for 0001's column check on runs.outcome.

ALTER TABLE runs DROP CONSTRAINT runs_outcome_check;
ALTER TABLE runs ADD CONSTRAINT runs_outcome_check CHECK (outcome IS NULL OR outcome IN ('completed', 'escalated', 'stopped', 'cancelled'));

UPDATE store_meta SET schema_version = 4 WHERE singleton = 1;
