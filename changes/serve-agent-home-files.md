---
packages: @parcha/agentrun-serve
kind: feature
---
Each agent now has a home, a directory of its own under the data directory that stays across its runs. `GET /v2/agents/{id}/home/files` lists its files in the shape of a run's file list, and `GET`, `PUT` and `DELETE` on a file's path below it read, write and remove one, whole and never through a link, up to `capabilities.home.max_file_bytes`. `learning/` is the server's: listed with `host_owned: true` and readable, but a write or delete there is `403 system_file_forbidden`. Runs do not see the home yet, and `GET`/`PUT /agents/{id}/home` still answer `501`.
