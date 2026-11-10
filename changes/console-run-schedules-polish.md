---
packages: repo
kind: fix
---
The console's run page, timeline and schedules read better.

- **Steps:** a step's line shows its bold and code as such; nothing else of Markdown is read, and no HTML gets through.
- **Answers:** an answer the agent left empty (or only spaces) reads "The agent finished without writing an answer.", with "Send a follow-up below to ask for one." when the run takes messages.
- **The fold:** it says "1 earlier step" for one.
- **Your messages:** a message of several lines reads its first line and "…".
- **Files tab:** files in dot and cache folders (.git, __pycache__, node_modules…) wait behind "Show N hidden", and the tab's count is what it lists.
- **Waits:** a run that waits on you in its browser or on its computer says where, with the server's instruction.
- **Phones:**
  - the run header goes compact once the steps scroll;
  - the runs list never widens past the screen.
- **Deleted triggers:** a run whose trigger was deleted reads "<Kind> deleted" (or "Trigger deleted" in the runs list), with no link, once a fresh read of the triggers lacks it.
- **Playground snippets:** they name AGENTRUN_API_KEY.
- **Schedules:**
  - a schedule the server turned off reads "Turned off" with why (after N failures in a row, a source it can't read, an archived agent, a lost connection) and what to do, never "Paused";
  - a firing that caught up a missed time says so;
  - the cap field says its rule before an agent is picked.
