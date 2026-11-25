-- runners: breaking
-- Version 29: the census (0027, in 0.1.0-beta.57) without its second state. 0027 marked each launch holding sealed
-- secrets "pending" and kept that rule in a trigger, a rule the store kept too. Here a launch's census is null until an
-- end writes it, and one narrower rule stays in the table: an update that erases a launch's sealed bytes and leaves its
-- census null writes "unscanned". This build's end always names a census when it erases them, so only an end by a
-- runner of 0.1.0-beta.56 or earlier does that: one still live beside this server, or draining (each busy run goes on to
-- its end, up to its drain timeout) after the floor read this migration's mark makes it take (every 10 s). That run's
-- files are withheld, never read cut of the server's values alone. Each "pending" 0027 left is settled as this build
-- reads it: null on a launch still holding its secrets (its end counts them), "unscanned" on one an end erased (nothing
-- counted them). A server of 0.1.0-beta.57 still writing during the deploy may mark a launch "pending" after this; this
-- build reads that as no census it knows, so the run's files are withheld, live and after its end, never read uncut.
-- Applied once, after 0028, inside the transaction migrate.ts opens. Never edit this file once applied: a change is a
-- new file.
DROP TRIGGER IF EXISTS run_launch_census_on_seal ON run_launch;
DROP FUNCTION IF EXISTS run_launch_census_on_seal();
UPDATE run_launch SET census = CASE WHEN sealed IS NULL THEN '"unscanned"' ELSE NULL END WHERE census = '"pending"';
CREATE OR REPLACE FUNCTION run_launch_census_erased() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sealed IS NOT NULL AND NEW.sealed IS NULL AND OLD.census IS NULL AND NEW.census IS NULL THEN
    NEW.census := '"unscanned"';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS run_launch_census_erased ON run_launch;
CREATE TRIGGER run_launch_census_erased BEFORE UPDATE OF sealed ON run_launch
  FOR EACH ROW EXECUTE FUNCTION run_launch_census_erased();
UPDATE store_meta SET schema_version = 29 WHERE singleton = 1;
