---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
A finished look-back or revise round keeps its outcome sentence after a reload. A run's grade now keeps the feedback round it opened: `GET /runs/{id}/learning`'s `graded` is the grade as `PUT /runs/{id}/grade` answered it, without `expected` (`run_id`, `correct`, `source`, `graded_at`, `path`, `workflow`, `workflow_digest`, `feedback`), plus `feedback_ended`, whether that round ended as the run's journal orders it (never the server's `graded_at` against the runner's `ended_at`), so the console's Grade control says what came of a grade from the read alone, and stays "Reviewing" until the round ended and its learning settled. The round is written on the grade only once the run opened again on it: a reopen that fails leaves a grade with `feedback: null`.
Upgrading: a client reading `graded` gets the PUT's fields; `correct`, `source` and `graded_at` are unchanged.
