-- The store's schema on Postgres, version 6: the run-change feed (Runs.changedSince), each channel post's tries (the
-- outbound webhook's deliveries log) and the claim a post's try settles under, as SQLite's schema version 8 has them.
--
-- A change is a run reaching a final state, or let go by its runner (parked, or running with none), written by the
-- trigger below in the transaction of the write that made it. Postgres has many writers, so a sequence alone does not
-- number changes in commit order: the trigger takes one transaction-scoped advisory lock before it inserts, so two
-- transactions that each write a change commit them in seq order, and a reader that has read seq n has every change at
-- or below it. The trigger is deferred to the commit, so the lock is held only while the change is numbered and the
-- transaction commits: a run's end write and the statements after it never wait on another run's, which would make a
-- runner of many loops end its runs one at a time.
CREATE TABLE IF NOT EXISTS run_changes (
  seq BIGSERIAL PRIMARY KEY,
  run_id TEXT COLLATE "C" NOT NULL,
  state TEXT COLLATE "C" NOT NULL,
  ended_at BIGINT,
  epoch BIGINT NOT NULL,
  runner TEXT COLLATE "C"
);

CREATE OR REPLACE FUNCTION run_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || '.run_changes'));
  EXECUTE format('INSERT INTO %I.run_changes (run_id, state, ended_at, epoch, runner) VALUES ($1, $2, $3, $4, $5)', TG_TABLE_SCHEMA)
    USING NEW.id, NEW.state, NEW.ended_at, NEW.epoch, NEW.runner;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS runs_changed ON runs;
CREATE CONSTRAINT TRIGGER runs_changed AFTER UPDATE OF state, runner ON runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN ((OLD.state IS DISTINCT FROM NEW.state OR OLD.runner IS DISTINCT FROM NEW.runner)
    AND (NEW.state IN ('ended', 'stopped', 'failed', 'parked') OR (NEW.state = 'running' AND NEW.runner IS NULL)))
  EXECUTE FUNCTION run_changed();

-- A post's try settles under the claim that made it (Channels.settle's fence): the claim's token, kept on the post until
-- a newer claim or a write outside every claim takes it.
ALTER TABLE channel_posts ADD COLUMN IF NOT EXISTS claim TEXT COLLATE "C";

-- Each try once, by its id: a settle written again (its outcome unknown) logs it once.
CREATE TABLE IF NOT EXISTS channel_attempts (
  seq BIGSERIAL PRIMARY KEY,
  try_id TEXT COLLATE "C" NOT NULL UNIQUE,
  channel TEXT COLLATE "C" NOT NULL,
  post_id TEXT COLLATE "C" NOT NULL,
  moment TEXT COLLATE "C" NOT NULL,
  at BIGINT NOT NULL,
  status_code BIGINT,
  latency_ms BIGINT NOT NULL,
  error TEXT COLLATE "C",
  retry_at BIGINT,
  redelivery BIGINT NOT NULL CHECK (redelivery IN (0, 1))
);
CREATE INDEX IF NOT EXISTS channel_attempts_by_channel ON channel_attempts (channel, seq);

UPDATE store_meta SET schema_version = 6 WHERE singleton = 1;
