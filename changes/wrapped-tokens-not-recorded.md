---
packages: @parcha/agentrun-serve, @parcha/agentrun-import, @parcha/agentrun-client
kind: fix
---
Wrapped no longer says 0 tokens or $0 for requests whose session records no tokens (Cursor keeps none). `GET /v2/wrapped` and `wrappedHome` count those requests as `tokens_unknown_requests` (`tokensUnknownRequests` in the importer) for the year, each harness and each model. The page says "Tokens not recorded" and "Cursor doesn't record tokens" for a year where no request recorded any, counts the busiest day by requests, and reads "no known price" where no request was priced. A year where only some requests lack tokens keeps its token total and adds "+ N requests with no recorded tokens". The cover and summary cards show "Unknown" tokens and a "Tokens not recorded" row. The console names the Cursor harness "Cursor".
