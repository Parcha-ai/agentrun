---
packages: repo
kind: feature
---
The run page has one Screen tab for every kind of computer, in place of Watch live. A browser's page, a desktop's or a phone's screen is framed live through the server's own viewer (GET /v2/runs/{id}/computer), with who drives. A desktop or phone has Take over and Hand back on the tab; a browser keeps its own in its viewer. A sandbox's run has the tab too, saying it has no screen. A metered provider's line shows for a sandbox, desktop or phone, never a browser.

When the agent asks the person at its computer (its browser, a desktop or a phone), the ask shows above the run's page and in Mission Control's Needs you: "The agent asks you to: …" and "Done when: …" as plain text, the console's own line "You never need to type your AgentRun password for this.", and when it expires. The run page moves to the Screen tab. Done and Cancel answer the ask once, through POST /v2/runs/{id}/computer/hand-back. An answer that came second, or one after the ask expired, says so, and the words stay after the ask's card is gone. While the ask waits, the message box says a message steers the run and doesn't answer the ask.
