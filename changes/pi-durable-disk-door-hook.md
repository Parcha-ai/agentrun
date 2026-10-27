---
packages: @parcha/pi-durable-disk
kind: feature
---
`AppOptions.door` hands `serve`'s door to a harness of the app's own (`DoorHook`: `submit`, `abort`, `busy`). Each submit is admitted in the root conversation (a `door.input` entry, through the run's fenced commit) before the hook sees it, a requestId reaches `hook.submit` at most once across incarnations, and its outcome settles the same record: `ADMITTED` 202, `ACCEPTED` 200, `REJECTED_BUSY` 409, `FAILED` 500, and `UNKNOWN` 504 at the submit bound (30 s, `ServeOptions.doorTimeouts`), whose late outcome is still written. `POST /abort` and `GET /status` go through the hook, `GET /events` merges its `run_start` and `run_end` with the conversation's entries, and a SIGTERM drain aborts it and kills the harness children it adopted. Without `door` the door is unchanged.
A fenced lease now refuses every later commit through the run's storage, whatever fenced it; before, only the watchdog's lapse did.
