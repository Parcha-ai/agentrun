---
packages: repo
kind: fix
---
A run paused at its spend cap says why once, in its banner. On the timeline, the refused request's row is a quiet marker, "Paused at its spend cap", in the warning tone, where it read as a red "Error" repeating the banner's sentence. The server's words open with the row. The server marks that row `paused: true` (it keeps kind `error`). It stays a pause after the cap is raised, and it no longer counts as a failure on the page. The run's waiting row says what the run waits on, as its status does: "Paused at cap" for a cap pause, "Approval required" for an approval, "Input required" otherwise. Any other error is unchanged.
