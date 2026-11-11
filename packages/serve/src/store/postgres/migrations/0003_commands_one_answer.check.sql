-- The check before 0003 (migrate.ts runs it first; each row refuses the migration in its words). 0003's unique index
-- takes one unrefused answer per approval of a run; a store an earlier build left after an approve and a deny raced can
-- hold two. Nothing is changed here: the words name the run, the call and its answers, and give the statement that keeps
-- the first (the one the run's runner took first) and refuses the rest, as SQLite's open does.

SELECT format(
  'run %s has %s answers to its tool call %s (commands %s), and only one may stand: keep the first and refuse the others with '
    || 'UPDATE %I.commands SET refused = %L, taken_at = COALESCE(taken_at, (extract(epoch FROM now()) * 1000)::bigint) WHERE id IN (%s), '
    || 'then start the server again',
  run_id, count(*), body::json ->> 'approval',
  string_agg(id || ' (' || kind || ')', ', ' ORDER BY id),
  current_schema(), 'a second answer to one approval: the first one stands',
  array_to_string((array_agg(id ORDER BY id))[2:], ', ')
) AS refusal
FROM commands
WHERE kind IN ('approve', 'deny') AND refused IS NULL AND body::json ->> 'approval' IS NOT NULL
GROUP BY run_id, body::json ->> 'approval'
HAVING count(*) > 1
ORDER BY min(id);
