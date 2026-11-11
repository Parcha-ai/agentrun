---
packages: @parcha/pi-browser
kind: fix
---
A browser that opens with its agent's saved sign-in now says so before its tools. The prompt section's second line reads "This agent has a saved browser sign-in, and this browser opens with it", and it tells the model to use the browser, not `web_fetch`, for a page that needs it signed in, because `web_fetch` reads every page signed out. `run`'s description says the same. Before, the model was told only that the browser "keeps this agent's saved sign-ins", which didn't say one existed, so it fetched a signed-in page with `web_fetch` and read the sign-in page. Nothing changes for a browser with no saved sign-in. The line names no site, profile or account: a saved sign-in doesn't record which sites it covers.
