---
packages: repo, @parcha/agentrun-serve
kind: fix
---
`GET /v2/setup/import` answers `200 { "offer": false }` where it answered `404`: to the signed-in owner when no import was asked for at setup, and to the setup page of a server that cannot import (a public address, or open setup off loopback). The console reads that answer as no offer, so its first page no longer logs a failed request in the browser; it still reads a `404` from an older server the same way. An offer, its count and an import's state answer as before, and a browser that is not signed in still gets `404` once the owner is set.
