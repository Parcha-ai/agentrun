-- Version 26: a run's disk (runs.disk, as store/schema.ts keeps it on SQLite): the disk the run's launch named as its own
-- (a customer's Archil disk, by its id), set once with the queued run; null for the default disk's. Learning reads an
-- agent's runs on one disk alone. Every run already here takes its disk from its launch body, as a new run's is taken at
-- its create; a run purged before this (0021) has no launch body left, so it reads as the default disk's, with nothing
-- of it left to learn from. Applied once, after 0025, inside the transaction migrate.ts opens. Never edit this file once
-- applied: a change is a new file.
--
-- The disk is read from a copy of each body that names one, its escaped NULs and surrogates (\u0000, \ud800-\udfff) read
-- as escaped spaces: Postgres's json functions refuse a whole document over one, and a run's input may hold one. A
-- replaced escape stays an escape (an escaped backslash before u0000 keeps its own), so the copy is still JSON, and only
-- the disk's id and kind are read from it (an Archil disk id holds neither).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS disk TEXT COLLATE "C";
UPDATE runs SET disk = launch.disk_id
  FROM (
    SELECT run_id, readable #>> '{archil_disk,disk_id}' AS disk_id, readable #>> '{archil_disk,kind}' AS kind
    FROM (
      SELECT run_id, regexp_replace(body, '\\u(0000|[dD][89a-fA-F][0-9a-fA-F]{2})', '\\u0020', 'g')::json AS readable
      FROM run_launch
      WHERE strpos(body, '"archil_disk"') > 0
    ) AS bodies
  ) AS launch
  WHERE launch.run_id = runs.id AND launch.kind = 'launch';
UPDATE store_meta SET schema_version = 26 WHERE singleton = 1;
