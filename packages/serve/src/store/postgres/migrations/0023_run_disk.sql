-- Version 23: a run's disk (runs.disk, as store/schema.ts keeps it on SQLite): the disk the run's launch named as its own
-- (a customer's Archil disk, by its id), set once with the queued run; null for the default disk's. Learning reads an
-- agent's runs on one disk alone. Every run already here takes its disk from its launch body, as a new run's is taken at
-- its create; a run purged before this (0021) has no launch body left, so it reads as the default disk's, with nothing
-- of it left to learn from. Applied once, after 0022, inside the transaction migrate.ts opens. Never edit this file once
-- applied: a change is a new file.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS disk TEXT COLLATE "C";
UPDATE runs SET disk = run_launch.body::json #>> '{archil_disk,disk_id}'
  FROM run_launch
  WHERE run_launch.run_id = runs.id AND run_launch.body::json #>> '{archil_disk,kind}' = 'launch';
UPDATE store_meta SET schema_version = 23 WHERE singleton = 1;
