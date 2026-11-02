---
packages: repo
kind: fix
---
The console tells a workflow run that escalated from one that was accepted. A run that completed with `review` (it waits for a person) reads "Needs review" in its badge, never a green "Completed". The run header and the Runs list say its reason, and its Report says the reason and the node it stopped at in place of "This run gave no answer". Mission Control's recent runs and an agent's runs follow the badge. Where `/v2/stats` counts such runs apart (`needs_review`), Mission Control says them under Failed and the analytics' outcomes read "completed · failed · need review", with a run waiting for review counted as no success. An older server's "failed or escalated" reads as before. A run graph's judge says its verdict with that verdict's own probability, as the timeline does ("no 0.99", not "no 0.01").
