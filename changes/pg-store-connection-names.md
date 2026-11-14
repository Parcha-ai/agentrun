---
packages: @parcha/agentrun-serve
kind: fix
---
On Postgres, the store's pool connections are named for their schema in `pg_stat_activity` (`application_name` `agentrun-store:<schema>`), as its lease (`agentrun-store-lease:<schema>`) and owner lock (`agentrun-store-owner:<schema>`) connections are, so an operator can tell which store holds each connection. Before, every pool connection was `agentrun-store`.
