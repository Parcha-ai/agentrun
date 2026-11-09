---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
A template applied from the owner's session shows each webhook trigger it made its signing secret once. `POST /v2/templates/{name}/apply` answers `webhook_secrets`, one per webhook trigger it made (absent when it made none): its `trigger_id`, its secret's metadata as `secret` (named `trigger:<id>`), and, in the first answer to the owner's signed-in session alone, `signing_secret`, as `POST /v2/triggers` shows it. The Idempotency-Key's record never keeps a value: a replay under the same key answers `secret_set` and a note that it was shown once, and an apply with the API token answers `secret_set` and the words that send the person to the console to rotate it there. The warning under `triggers.<i>.secret` stays. Upgrading: a script that read `webhook_secrets[].secret` as the value now reads `signing_secret`, from the owner's session; the token gets none.
