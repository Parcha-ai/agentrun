---
packages: repo
kind: fix
---
The run page reads the run again when it moves from one wait to the next with the same status, so the card the person answers is never an earlier wait's. A hand-back in the Screen tab's viewer answers the agent's browser ask, and the agent often asks its next question at once. The page re-read the run only when its status or state changed, and both waits read "input required, waiting", so it could keep showing the hand-over's card in place of the question. While the run waits, any new timeline page now reads the run again.
