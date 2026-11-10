---
packages: repo, @parcha/agentrun-serve
kind: fix
---
The run page shows the agent's question after you hand the browser back. A hand-back in the Screen tab's viewer answers the agent's browser ask, and the agent often asks its next question at once. The page re-read the run only when its status or state changed, and both waits read "input required, waiting", so it could keep showing the hand-over's card. While the run waits, any new timeline page now reads the run again. The served Timeline (`GET /v2/runs/{id}/timeline`) also carries a waiting row for a question the agent asked again, as the run's view does. The page's "The agent asks" box reads the question from that row, and without it the box showed an earlier wait's words, or nothing.
