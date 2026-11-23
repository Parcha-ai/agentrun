-- Version 27: a run's census (run_launch.census, as store/schema.ts keeps it on SQLite): where in each of the run's files
-- the secrets its caller handed it sat when its end erased them (run-census.ts), never the secrets; "pending" from when
-- a launch first holds sealed secrets until an end counts them (each launch holding them now is marked so here);
-- "unscanned" when an end erased them with no census made under them; null when a launch never held any (none handed,
-- or a run ended before this). Applied once, after 0026, inside the transaction migrate.ts opens. Never edit this file once
-- applied: a change is a new file.
ALTER TABLE run_launch ADD COLUMN IF NOT EXISTS census TEXT COLLATE "C" CHECK (census IS NULL OR census::json IS NOT NULL);
UPDATE run_launch SET census = '"pending"' WHERE sealed IS NOT NULL AND census IS NULL;

-- The same census rule for a write that never names it (store/sqlite/run-launch.ts censusOnSeal), held by the table: a
-- server of an earlier build still serving while this applies (a rolling deploy) writes sealed bytes and no census. Its
-- insert of a launch holding sealed bytes takes "pending", so an end by an earlier runner (which erases them and writes no
-- census) leaves "pending", read as uncounted, never as a launch handed nothing. Its seal over a "pending" whose sealed
-- bytes an end erased turns it to "unscanned", as this build's does: that end counted nothing, so the files it left stay
-- withheld, not cut of the new values alone. A write that names a census (this build's) keeps it.
CREATE OR REPLACE FUNCTION run_launch_census_on_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sealed IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.sealed IS NULL AND OLD.census = '"pending"' AND NEW.census IS NOT DISTINCT FROM OLD.census THEN
      NEW.census := '"unscanned"';
    ELSE
      NEW.census := COALESCE(NEW.census, '"pending"');
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS run_launch_census_on_seal ON run_launch;
CREATE TRIGGER run_launch_census_on_seal BEFORE INSERT OR UPDATE OF sealed ON run_launch
  FOR EACH ROW EXECUTE FUNCTION run_launch_census_on_seal();
UPDATE store_meta SET schema_version = 27 WHERE singleton = 1;
