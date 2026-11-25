-- runners: breaking
-- Version 29: the census (0027, in 0.1.0-beta.57) without its rolling-deploy cover. 0027 marked each launch holding sealed
-- secrets "pending" and kept that rule in a trigger, so an end by a runner of an earlier build, which erases the secrets
-- and writes no census, left the run's files withheld. That cover was a second census state and a rule kept twice (the
-- store and this trigger) for a window of seconds. This migration raises the runner floor to 29 instead: each runner of an
-- earlier build stops at its next floor read (every 10 s) and hands its runs back. A run such a runner ends before that
-- read has no census, and its files read as a run ended before the census does: cut of the server's values alone. The
-- trigger goes, and a launch's census is null until an end writes it. Each "pending" left is settled as this build reads
-- it: null on a launch still holding its secrets (its end counts them), "unscanned" on one an end erased (nothing counted
-- them). A server of an earlier build still writing during the deploy may mark a launch "pending" after this; this build
-- reads that as no census it knows, so its run's files are withheld, never read uncut.
-- Applied once, after 0028, inside the transaction migrate.ts opens. Never edit this file once applied: a change is a
-- new file.
DROP TRIGGER IF EXISTS run_launch_census_on_seal ON run_launch;
DROP FUNCTION IF EXISTS run_launch_census_on_seal();
UPDATE run_launch SET census = CASE WHEN sealed IS NULL THEN '"unscanned"' ELSE NULL END WHERE census = '"pending"';
UPDATE store_meta SET schema_version = 29 WHERE singleton = 1;
