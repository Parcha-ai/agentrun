---
packages: @parcha/agentrun-serve
kind: feature
---
Uploads: `POST /v2/files` reserves a file and `PUT /v2/files/{file_id}` takes its bytes, and a run's `file_ids` reach its workspace. Both routes answered `501` before. The bytes are streamed to disk (the 1 MiB JSON body cap does not apply), checked against the reserved `size_bytes` and `sha256` (`422 input_invalid`), and capped at `limits.max_upload_bytes`, 50 MiB (`413`). A run names up to `limits.max_files_per_run`, 20, ready files; an unknown, pending or repeated one is `422` at `file_ids` before anything starts. Each is copied into the run's `work/inputs/` at its `path`, folders kept, before the run's process starts; a name already taken gets a suffix (`notes-2.txt`). Capabilities now say `features.files.upload: true`.
The page's session cookie may send a file's bytes with any content type to `PUT /v2/files/{file_id}`, still only with the page's own `Origin`. A route takes that rule only by a `raw` mark in the route table, which only a `PUT` may carry; every other write from the page still needs `application/json`, and the token is unchanged.
