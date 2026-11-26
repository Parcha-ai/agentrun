---
packages: @parcha/agentrun-serve
kind: fix
---
A run started while another run of its agent is still keeping a follow-up's or a grade's correction now starts from that correction. Before, the run's learning was read when it was started: a host that launched the next run as soon as the corrected run read `completed` (its compile turn can still run for minutes after that) got a run with nothing learned, though the correction merged a moment later. The new run's claim now waits for those rounds to end, at most 3 minutes, then reads its agent's learning again. A run started with no such round open starts as before. `GET /v2/runs/{run_id}/learning` also gives `seed_failed` (why a run started with nothing learned: `unreadable`, `not_copied` or `other_disk`; null when its learning was read) and `learned_chars` (the length of the # Learned text it was given).
