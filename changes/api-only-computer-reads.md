---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server (`AGENTRUN_API_ONLY=1`) now serves `GET /v2/computers` and `GET /v2/workspace/archil` with its token, so a backend in front of it can read which computer providers are ready and whether runs' folders are on Archil before it launches. Both answer key names and whether each is saved, never a value. Their writes, tests and key choices (`PUT`, `DELETE` and `POST .../test` on either, `PUT /v2/computers/{provider}/keys`, `GET /v2/computers/{provider}/choices`) are still refused there.
