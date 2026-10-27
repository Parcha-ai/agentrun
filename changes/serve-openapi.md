---
packages: @parcha/agentrun-serve
kind: feature
---
`GET /v2/openapi.json` serves this API as an OpenAPI 3.1 document, with no credential, as capabilities are, and capabilities link it (`links.openapi`). It is the `agentrun.v2/0` contract, vendored unchanged in `src/openapi/agentrun-v2.openapi.json` with its source (repository, pull request and commit) in `info.x-agentrun-source`. The server marks its own routes outside the contract (`GET /runs`, `GET /agents/{id}/revisions`, `POST /agents/{id}/current`, and the document itself) `x-agentrun-serve: true`, and the six operations it answers `501` (home export and import, kill, the two upload routes and quotes) `x-agentrun-serve-unsupported` with the reason. A test holds the document to the server's route table, both ways.
