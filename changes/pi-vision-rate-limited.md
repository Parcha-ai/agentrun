---
packages: @parcha/pi-vision
kind: fix
---
A Jev request rate-limited to the end of the runner's retries (`http`, HTTP 429) is filed as a `look_failed` miss that cost nothing ("Jev failed: rate limited, ..."), so the run's cost stays known.
