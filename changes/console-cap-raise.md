---
packages: repo
kind: feature
---
The console raises a run's spend cap. On a run paused at its cap, beside the cap's banner, the new cap is prefilled with the server's suggestion (`pending.suggested_cap_usd`), editable, and "Raise the cap and continue" sends it once (`PATCH /v2/runs/{id}`); the run is read again and goes on. The run header offers "Raise the cap" for any capped agentic run that has not ended, so a working run can be raised before it pauses; its answer's note (the live process keeps its old cap until its next one) is shown. A refusal is said under the input in the server's words (422), and an ended run (409) or a run the server no longer has (404) in plain words. The Report tab of a paused run reads "Paused at its spend cap", with what it spent of its cap.
