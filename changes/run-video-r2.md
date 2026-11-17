---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A run's screen recordings can be read through the API and exported from the console.
- The run read lists them in `recordings`: each one's `path`, `computer`, `seconds`, `bytes` and whether it is `finished`. Empty when the agent doesn't record.
- `GET /v2/runs/{run_id}/files/recordings/<computer>.mp4` serves one as `video/mp4`, read-only, to whoever may read the run's other files; `?download=1` for an attachment. One still being written is served as it stands.
- The files route answers one byte range (`Range`, `206` with `Content-Range`; past the end, `416 range_not_satisfiable`) for every file, so a `<video>` can seek: `features.files.range` is now true.
- A recording reaches the disk as it is made, a fragment every 2 seconds or so: a quiet screen's few frames no longer sit in ffmpeg's input probe (and a phone's PNG frames in its decoder's threads) until the recording's end.
- The console's Screen tab says "Recording" while a recording is written, and offers Export once it is finished.
- Breaking: a folder an agent makes named `recordings` at the root of its run's `work/` is no longer listed or served: that path is the run's recordings.
