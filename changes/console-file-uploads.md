---
packages: repo
kind: feature
---
The console's start screens take files. The Playground and the agent page's run bar each have a file picker, a button and a drop zone, that sends each picked file at once (`POST /v2/files?path=<its name>`), all in parallel, with its size and how much is sent. The run names them (`file_ids`) and finds them in `inputs/`; it starts only once each is sent. The server's limits from capabilities (`limits.max_upload_bytes`, `limits.max_files_per_run`) are said under the picker and kept before anything is sent, and a refusal the server gives is said there in its words. Removing a file stops its send, or deletes it from the server when it was sent.
