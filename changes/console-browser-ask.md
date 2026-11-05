---
packages: repo
kind: feature
---
When a run's agent asks for you in its browser, the console shows the ask in Mission Control's Needs you and above the run's page: what to do there, "Done when: …", and when the ask expires. Both come from the run alone, so an ask still open after a restart shows on a fresh page load. The run page opens on its Browser tab, where Take over and Hand back sit in the viewer's own bar. Done and Cancel answer the ask (`POST /v2/runs/{id}/browser/hand-back`) on a server whose `features.browser_live.ask` is on. An answer that came second, or one after the ask expired (409 `handoff_answered`), reads the run again and says so. A 403 says to sign in with your password, which is the only way this route answers. While the ask waits, the message box says a message steers the run and doesn't answer the ask. The live view's frame now allows forms, so a take-over can use the viewer's address bar.
