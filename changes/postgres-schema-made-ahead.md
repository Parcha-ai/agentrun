---
packages: @parcha/agentrun-serve
kind: fix
---
The server starts on a Postgres schema an administrator made ahead of time, with a role that owns that schema and has no `CREATE` on the database. At its start the server now makes the schema only when it is absent (Postgres refuses `CREATE SCHEMA IF NOT EXISTS` to a role without `CREATE` on the database even when the schema exists), then migrates it as before. On a schema that does not exist, such a role is refused at the start in words that name the schema and what to do: create the schema ahead of time, owned by the role, or grant the role `CREATE` on the database.
