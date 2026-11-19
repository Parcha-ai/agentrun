-- Version 17: each run's listing on its row (store/schema.ts RUN_LISTING_COLUMNS, as SQLite's schema version 12 keeps it):
-- what a runs list shows of the run, so a list reads rows alone and never builds a run's view. list_mark moves (+1) in the
-- transaction of every write that can change the run's view: its journal's commits (store/journal/storage.ts), its row's
-- state, claim, cost and end (runs_list_moved), its commands (commands_list_moved), its learning's rows
-- (learning_list_moved), and its learning run's or audit's own moves (runs_list_parent). The server's lister rebuilds a
-- listing from the run's view and writes it with the mark it read before it built (listing_mark), so a row whose listing is
-- behind says so. Every run starts behind; a settled run's status is set from its row here (an end that is no person's stop
-- of an agentic run). Applied once, after 0016, inside the transaction migrate.ts opens. Never edit this file once
-- applied: a change is a new file.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS list_mark BIGINT NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS listing TEXT COLLATE "C" CHECK (listing IS NULL OR listing::json IS NOT NULL);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS list_status TEXT COLLATE "C";
ALTER TABLE runs ADD COLUMN IF NOT EXISTS listing_mark BIGINT NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS listing_live BIGINT NOT NULL DEFAULT 0 CHECK (listing_live IN (0, 1));
ALTER TABLE runs ADD COLUMN IF NOT EXISTS listing_until BIGINT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS listing_flags BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS runs_listing_behind ON runs (started_at) WHERE listing_mark < list_mark;
CREATE INDEX IF NOT EXISTS runs_listing_live ON runs (started_at) WHERE listing_live = 1;
CREATE INDEX IF NOT EXISTS runs_listing_until ON runs (listing_until) WHERE listing_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_by_list_status ON runs (list_status, started_at);
CREATE INDEX IF NOT EXISTS runs_listing_flagged ON runs (agent_id) WHERE listing_flags <> 0;
CREATE INDEX IF NOT EXISTS learning_proposals_by_learning_run ON learning_proposals (learning_run_id) WHERE learning_run_id IS NOT NULL;

-- The run's own mark, for a change of its row a list may show (a renew, which moves only claimed_until, is none), and its
-- list_status from the row: a settled run's status, else none until its listing is built.
CREATE OR REPLACE FUNCTION run_list_moved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('UPDATE %I.runs SET list_mark = list_mark + 1, list_status = CASE
      WHEN state = ''ended'' THEN ''completed''
      WHEN state = ''failed'' THEN ''failed''
      WHEN state = ''stopped'' AND (outcome IS NULL OR outcome <> ''stopped'' OR imported_from IS NOT NULL
        OR (SELECT kind FROM %I.revisions WHERE revisions.id = runs.revision_id) <> ''agentic'') THEN ''cancelled''
      ELSE NULL END
    WHERE id = $1', TG_TABLE_SCHEMA, TG_TABLE_SCHEMA) USING NEW.id;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS runs_list_moved ON runs;
CREATE TRIGGER runs_list_moved AFTER UPDATE OF state, epoch, runner, cost_usd, cost_upper_bound, metrics, summary, outcome, imported_from, sign_in_handed, labels, ended_at ON runs
  FOR EACH ROW EXECUTE FUNCTION run_list_moved();

-- A learning run's or an audit shadow run's move is its served run's too: that run's view reads them.
CREATE OR REPLACE FUNCTION run_list_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id LIKE 'audit.%' THEN
    EXECUTE format('UPDATE %I.runs SET list_mark = list_mark + 1 WHERE id = $1', TG_TABLE_SCHEMA) USING substr(NEW.id, 7);
  END IF;
  EXECUTE format('UPDATE %I.runs SET list_mark = list_mark + 1 WHERE id IN (SELECT run_id FROM %I.learning_proposals WHERE learning_run_id = $1)', TG_TABLE_SCHEMA, TG_TABLE_SCHEMA) USING NEW.id;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS runs_list_parent ON runs;
CREATE TRIGGER runs_list_parent AFTER UPDATE OF list_mark ON runs
  FOR EACH ROW WHEN (pg_trigger_depth() < 3) EXECUTE FUNCTION run_list_parent();

-- A command written, taken or refused, and a learning row written or changed: its run's mark, moved at the commit of the
-- write's transaction (deferred), still inside it. The run's row is locked only for that moment: a command whose
-- transaction waits on something else (its launch row) never holds up the run's journal commits, or the run's other
-- commands, which take their ids in the order they were inserted.
CREATE OR REPLACE FUNCTION run_list_of_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('UPDATE %I.runs SET list_mark = list_mark + 1 WHERE id = $1', TG_TABLE_SCHEMA) USING NEW.run_id;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS commands_list_moved ON commands;
CREATE CONSTRAINT TRIGGER commands_list_moved AFTER INSERT ON commands DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION run_list_of_row();
DROP TRIGGER IF EXISTS commands_list_settled ON commands;
CREATE CONSTRAINT TRIGGER commands_list_settled AFTER UPDATE OF taken_at, refused ON commands DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION run_list_of_row();
DROP TRIGGER IF EXISTS learning_list_moved ON learning_proposals;
CREATE CONSTRAINT TRIGGER learning_list_moved AFTER INSERT OR UPDATE ON learning_proposals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION run_list_of_row();

UPDATE runs SET list_status = CASE
    WHEN state = 'ended' THEN 'completed'
    WHEN state = 'failed' THEN 'failed'
    WHEN state = 'stopped' AND (outcome IS NULL OR outcome <> 'stopped' OR imported_from IS NOT NULL
      OR (SELECT kind FROM revisions WHERE revisions.id = runs.revision_id) <> 'agentic') THEN 'cancelled'
    ELSE NULL END;
UPDATE store_meta SET schema_version = 17 WHERE singleton = 1;
