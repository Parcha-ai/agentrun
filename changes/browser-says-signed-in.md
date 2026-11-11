---
packages: @parcha/pi-browser
kind: fix
---
A browser that opens with its agent's saved browser profile now says so before its tools. The prompt section's second line tells the model that a site the agent was signed in to there opens signed in, to use the browser rather than `web_fetch` for a page that needs a sign-in (`web_fetch` reads every page signed out), and that a sign-in page means the profile holds no sign-in for that site. `run`'s description says the same. Before, the model was told only that the browser "keeps this agent's saved sign-ins", which didn't connect a signed-in page to the browser, so it fetched one with `web_fetch` and read the sign-in page. The line promises no sign-in, because an agent's first profile is new and holds none, and it names no site, profile id or account: a saved profile doesn't record which sites it covers. Nothing changes for a browser with no saved profile.
