---
packages: @parcha/agentrun-serve
kind: fix
---
The console's agent cards keep their chips on one row at every width: when a card's chips and its three actions don't fit side by side, the actions move to a row of their own and the chips keep theirs ("1 revision · 1 run" stacked one under the other at 820 px, and the Learning chip dropped under its counts at 1440 px). A real-browser flow (`agent-card-footer` in `npm run test:e2e`) measures every card at 1440, 1150, 820 and 390 px: each chip on one line, a card's chips on one row whenever that row fits, nothing past the card's right edge, every action the same square.
