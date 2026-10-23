---
packages: repo
kind: feature
---
examples/web: `AGENT_BROWSER` is `local`, `browserbase` or `kernel`, with no default. A run of an agent with a browser tool and no setting is refused with `set AGENT_BROWSER (or --browser): local (no key; a Chrome on this machine), browserbase (BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID) or kernel (KERNEL_API_KEY)`; Browserbase is no longer picked just because its key is set. `local` is the run's own Chrome (`CHROME_PATH`), `browserbase` needs `BROWSERBASE_API_KEY` (the project id stays optional), and `kernel` drives pi-browser's Kernel provider (`KERNEL_API_KEY`, optional `KERNEL_BASE_URL`) and keeps no sign-in between runs. `chrome` is accepted as `local` for one more release, with a notice. The README's first run sets `AGENT_BROWSER=local`, and a table lists the env and the network each value needs.
