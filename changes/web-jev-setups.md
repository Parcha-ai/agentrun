---
packages: @parcha/agentrun-web
kind: feature
---
Jev's web decider takes a setup: `jevWebDecider(jev, name?)`, with `JEV_SETUPS` and `DEFAULT_JEV_SETUP` exported. The default, `"shipped"`, answers exactly as before. `"top2-best300-found5"` keeps Jev's two most relevant search results whole and shows each later one only the passage of its snippet Jev scores most relevant (at most 300 characters; the url, title and relevance stay, and the sift line says to `web_fetch` the url to read it), and gives a fetch's objective 5 found chunks instead of 8.
