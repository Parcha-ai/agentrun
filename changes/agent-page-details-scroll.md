---
packages: @parcha/agentrun-serve
kind: fix
---
On an agent's page in the console, shown side by side (1024 px and wider), the agent's name, description and id stay in place and the details under them (its facts, tools, configuration and live jobs) scroll in their own box; the workspace beside them (runs, versions, learning, analytics) scrolls by itself. The whole page scrolled before, taking the name with it. Each box's scrollbar is slim, sits in a gutter of its own beside the cards, never over their edge, and shows only while the box is being scrolled or the pointer is on the bar; an edge the content goes on past fades out. The name, description and id take at most half the column: a description longer than that scrolls in a box of its own between the name and the id, so the details under them can always be reached. In one column, on a narrower window, the page scrolls whole as before.
