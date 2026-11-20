---
packages: @parcha/agentrun-serve
kind: fix
---
The console no longer shows a finished run as working again while it learns from a grade. A grade with words opens the run again for a few seconds so the agent can look back on it, and the server reads the run as working with no result during that time. The run page now shows a "Learning from your grade" status instead of Working, keeps the answer in place without the "Writing the answer" spinner, and hides Raise the cap, Stop, Cancel run and the message box until the look-back ends. Stop or Cancel at that point would have ended the run as stopped or cancelled instead of completed. A run doing its own job, or running its own end-of-run learning before its first answer, shows as before.
