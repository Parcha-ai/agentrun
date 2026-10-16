---
packages: repo
kind: feature
---
A place's signals may end with `{ kind: 'signals-failed', code, message }` (or its reader may throw): the supervisor writes a `signals.failed` host line and ends the attempt as after a failed kill, and nothing in the signals pump can end the supervisor. The messages of `kill.failed` and `signals.failed` have any absolute path outside the run's directory replaced by `<path>` and are capped at 240 characters.
