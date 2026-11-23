---
packages: @parcha/agentrun-serve
kind: feature
---
Console: Settings has a Demo page whose switch turns on demo mode, which fills the console with a sample company's nine agents (two of them connected Claude Code and Codex setups) and a month of their runs, so a person sees approvals, questions, live runs, workflow graphs, learning and triggers before setting anything up. A strip across every page says the data is sample data and turns it off.
- The demo is this browser's alone and is answered in the page: no run starts on the server, no model is called, nothing is spent, and the server's agents, runs and settings are not read or changed. The page asks the server only for the session, its capabilities (shown with every model and tool ready, without its secrets' names or its switches) and the templates it ships with.
- In the demo a person can answer a question, allow or deny a call, start, stop and archive a run, pause a trigger and run it now, and make or edit an agent (which runs as a stand-in that says so); these change the page's memory and a reload starts the story again. Every other write is refused with `demo_mode` and is not made. While it is on, Settings shows only the Demo page.
- Every person, company, address and figure in the demo is invented, with hosts ending in `.example`.
