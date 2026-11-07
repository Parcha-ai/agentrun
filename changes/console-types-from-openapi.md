---
packages: repo
kind: ci
---
The console's API types are generated from the server's OpenAPI document, as the CLI's command table is: `node scripts/generate-clients.mjs` also writes `apps/console/src/lib/api.generated.ts`, one TypeScript type per schema of `components.schemas` and, per operation, the JSON body it takes and the JSON it answers with. Its header holds the hash of the shapes it is made of (a description or an example changes nothing), and `--check`, which CI runs, fails when the committed file is not the document's. `apps/console/src/lib/v2.ts` names each wire type the console uses as an alias over the generated ones, so a change to the server's contract shows up in the console's typecheck.
