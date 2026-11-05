---
packages: @parcha/agentrun-serve
kind: fix
---
A saved sign-in is never forgotten while a run it was handed is still going: `DELETE /v2/agents/{id}/sign-ins/{key}` is `409 sign_in_held` with `details.handed_to` naming the run, its lease let go or not (a run waiting for its person, or one whose process went more than 30 minutes ago). Before, forgetting it then removed the pointer, so a restarted server could no longer read it back, and a run that had repeated it served it in its timeline and answer.
- A launch keeps that it handed a run the sign-in under the same lock forget asks under, so a forget never slips between the two.
- A run's error is cut of the values its rows and answer are cut of, in its view and in the run lists, and kept cut in its `serve.json`.
