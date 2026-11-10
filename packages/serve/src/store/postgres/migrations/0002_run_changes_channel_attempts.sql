-- The run-change feed (Runs.changedSince) and each channel post's tries (the outbound webhook's deliveries log), as
-- SQLite's schema version 5 has them.
--
-- A change is a run reaching a final state, or let go by its runner (parked, or running with none), written by the
-- trigger below in the transaction of the write that made it. Postgres has many writers, so a sequence alone does not
-- number changes in commit order: the trigger takes one transaction-scoped advisory lock before it inserts, so two
-- transactions that each write a change commit them in seq order, and a reader that has read seq n has every change at
-- or below it.
CREATE TABLE run_changes (
  seq BIGSERIAL PRIMARY KEY,
  run_id TEXT COLLATE "C" NOT NULL,
  state TEXT COLLATE "C" NOT NULL,
  ended_at BIGINT,
  epoch BIGINT NOT NULL,
  runner TEXT COLLATE "C"
);

CREATE FUNCTION run_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || '.run_changes'));
  EXECUTE format('INSERT INTO %I.run_changes (run_id, state, ended_at, epoch, runner) VALUES ($1, $2, $3, $4, $5)', TG_TABLE_SCHEMA)
    USING NEW.id, NEW.state, NEW.ended_at, NEW.epoch, NEW.runner;
  RETURN NULL;
END
$$;

CREATE TRIGGER runs_changed AFTER UPDATE OF state, runner ON runs
  FOR EACH ROW
  WHEN ((OLD.state IS DISTINCT FROM NEW.state OR OLD.runner IS DISTINCT FROM NEW.runner)
    AND (NEW.state IN ('ended', 'stopped', 'failed', 'parked') OR (NEW.state = 'running' AND NEW.runner IS NULL)))
  EXECUTE FUNCTION run_changed();

CREATE TABLE channel_attempts (
  seq BIGSERIAL PRIMARY KEY,
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
CREATE INDEX channel_attempts_by_channel ON channel_attempts (channel, seq);
