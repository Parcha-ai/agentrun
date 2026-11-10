---
packages: @parcha/agentrun-serve
kind: fix
---
Two edits to an agent in the same millisecond keep their revision numbers in order. Revisions are listed by their time and then their id, and two minted in one millisecond had random ids after the time, so the newer one could be numbered first: the wrong revision showed as current, a roll back went to the wrong one, and an If-Match against the right version could be refused. Ids minted in one millisecond now count up, and a clock that steps back keeps the last time.
