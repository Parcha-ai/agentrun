-- The store's schema on Postgres, version 29: each ledger row's learned workflow calls (learn/ledger.ts
-- LedgerRow.workflowCalls), as store/schema.ts keeps them on SQLite (LEARNING_LEDGER, LEARNING_LEDGER_ADDED). Applied once,
-- after the migration before it, inside the transaction migrate.ts opens. Never edit this file once applied: a change is
-- a new file. Additive: a runner of an earlier build writes no calls, and its rows read none (`[]`), as a run that called
-- no learned workflow does; its next end writes them again.
--
-- workflow_calls: the run's metrics' `workflow_calls` as JSON, each call's workflow, digest, caller (`platform` or
-- `agent`), outcome and booked $. Figures and names only, no run text. Added only where missing, so a store whose record
-- of this file was lost applies it again unharmed.
ALTER TABLE learning_ledger ADD COLUMN IF NOT EXISTS workflow_calls TEXT COLLATE "C" NOT NULL DEFAULT '[]' CHECK (workflow_calls::json IS NOT NULL);

UPDATE store_meta SET schema_version = 29 WHERE singleton = 1;
