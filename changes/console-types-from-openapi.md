---
packages: @parcha/agentrun-serve, repo
kind: fix
---
The OpenAPI document requires what the server always sends: a run's `revision`, `kind` and `archived_at`, on a run and in a list, and a trigger's `source.timezone` (a cron line's zone) and `source.start_at` (an interval's start) in every answer that holds a trigger. A write may still leave the last two out; the server fills them in, as before.

The console's API types are generated from that document, as the CLI's command table is: `node scripts/generate-clients.mjs` also writes `apps/console/src/lib/api.generated.ts`, one TypeScript type per schema of `components.schemas` and, per operation, the JSON body it takes and the JSON it answers with. Its header holds the hash of the shapes it is made of (a description or an example changes nothing), and `--check`, which CI runs, fails when the committed file is not the document's. `apps/console/src/lib/v2.ts` names each wire type the console uses as an alias over the generated ones, so a change to the server's contract shows up in the console's typecheck. The console's branches for values the server never sends are gone: a timeline row's `running`, `missing` and `interrupted` statuses and `ended_at`, a run's learning state `pending`, and a stats cost basis other than `estimate`.
