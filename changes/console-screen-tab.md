---
packages: repo
kind: feature
---
The run page has one Screen tab for every kind of computer, in place of Watch live. A browser's page, a desktop's or a phone's screen is framed live through the server's own viewer (GET /v2/runs/{id}/computer), with who drives. A desktop or phone has Take over and Hand back on the tab; a browser keeps its own in its viewer. A sandbox's run has the tab too, saying it has no screen. A metered provider's line shows for a sandbox, desktop or phone, never a browser. When the agent asks the person at its computer, the run page moves to the Screen tab and shows the ask with Done and Cancel, which answer it through POST /v2/runs/{id}/computer/hand-back.
