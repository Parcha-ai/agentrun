---
packages: @parcha/agentrun-serve
kind: fix
---
On a phone, the console's pages with a top bar scroll as a whole again, bar and all: Agents, Templates and a template's page, Triggers, the Learning Dojo, Suggested agents, a connected agent's page, New race, a race, and Compare runs. Keeping the bar in view at every size held much of a small screen, since a bar whose actions wrap is tall there (Triggers' is 197px at 390px wide, and with the console's own top bar it left 599 of 844px for the list). Beside the sidebar the bar stays in view as before.
