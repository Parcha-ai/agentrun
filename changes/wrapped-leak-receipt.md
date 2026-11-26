---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
Wrapped has a leak receipt, and the console draws it once the person turns it on. The import already cuts keys and tokens out of what it keeps of each session: the key-shaped values of its environment, the keys saved on the server, and keys of a format secretlint finds. It now keeps on each run how many distinct keys it cut from that run, as a number alone. `GET /v2/wrapped` answers `secrets` by adding up the year's runs from the store: `runs` counted, `runs_holding` (those that held a key) and `removed` (the keys cut, each once a run).
- `secrets` is null when no run of the year was counted. Only runs imported here count: a session left out of the import, or imported before this version, is not in it.
- The card is off until the person checks "Show the leak receipt" on the Wrapped page, and the page offers it only for a year whose keys were counted. It shows the keys cut, the sessions that held one and the sessions checked. It never shows a key, its shape or where it was.
- A password typed in a command, with no known key format, is not in the count.
