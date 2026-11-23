-- Version 27: a run's census (run_launch.census, as store/schema.ts keeps it on SQLite): where in each of the run's files
-- the secrets its caller handed it sat when its end erased them (run-census.ts), never the secrets; "pending" from when
-- a launch first holds sealed secrets until an end counts them (each launch holding them now is marked so here);
-- "unscanned" when an end erased them with no census made under them; null when a launch never held any (none handed,
-- or a run ended before this). Applied once, after 0026, inside the transaction migrate.ts opens. Never edit this file once
-- applied: a change is a new file.
ALTER TABLE run_launch ADD COLUMN IF NOT EXISTS census TEXT COLLATE "C" CHECK (census IS NULL OR census::json IS NOT NULL);
UPDATE run_launch SET census = '"pending"' WHERE sealed IS NOT NULL AND census IS NULL;
UPDATE store_meta SET schema_version = 27 WHERE singleton = 1;
