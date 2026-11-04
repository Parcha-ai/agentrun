---
packages: @parcha/agentrun-serve, @parcha/pi-browser, @parcha/pi-durable-agent
kind: fix
---
A browser call whose Browserbase key is refused now tells the model "Browserbase refused BROWSERBASE_API_KEY (401): set it where AgentRun starts, or save it in Settings → Tool keys. The browser can't open pages in this run.", the words a model key's refusal uses. It names `web_fetch` only when the run has it. It no longer says "use fetch (executor tools)", "browser plane" or "lane". pi-browser's failures name another tool only when the host passes it (`words.otherSource`), and the host can give its own words for a refused credential (`words.refusedCredential`); the pi coding agent extension, which always lists web_fetch, still points to it. The Timeline shows "Opened a live browser session" only once a browser call got a session, right before that call, so a refused open no longer reads as an opened session.
