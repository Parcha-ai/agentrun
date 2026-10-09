-- The agent's side of its memory: one row per machine it has run on, appended as it moves.
-- File: work/creature/memory.sqlite on the agent's disk. The tab only reads it.
-- `at` is an ISO-8601 UTC string; `kind` is one of: tab, sandbox, vm, gpu, other; `host` is the name the agent knew the machine by.
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, host TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS machines_at ON machines(at);
-- INSERT INTO machines (at, host, kind, note) VALUES (strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'gpu:4090-3', 'gpu', 'trained reward variant 3');
