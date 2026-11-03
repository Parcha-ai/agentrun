---
packages: @parcha/agentrun-serve
kind: breaking
---
Uploads work on the first try. `upload.url` in the answer to `POST /v2/files` is now a path from the server's root, `/v2/files/{file_id}`, where it was `/files/{file_id}` relative to `/v2`: a client that appended it to the `/v2` base (`$AGENTRUN_BASE_URL$url`) now sends it to the server's address instead (`${AGENTRUN_BASE_URL%/v2}$url`), or resolves it against the base as a URL; a doubled `/v2` answers a `404` that says so. The route itself, `PUT /v2/files/{file_id}`, is unchanged.
- A file is sent in one call: `POST /v2/files?path=<its path>` with its bytes as the body (`curl --data-binary @plan.md`), any type but a multipart form, answered `201` with the file `ready`, its length the body's and its hash its own. `content_type` and `sha256` may go in the query too, and `Idempotency-Key` replays the first file for the same bytes. The contract's two-step JSON reservation and `PUT` are kept.
- `GET /v2/files` lists the server's uploads, newest first, `GET /v2/files/{file_id}` reads one's record, and `DELETE /v2/files/{file_id}` removes it; a run that copied a deleted file keeps its copy.
- The page's session may send a file in one call with any content type, still only with the page's own `Origin`: `POST /v2/files` is marked to take bytes, beside `PUT /v2/files/{file_id}`.
