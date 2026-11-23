---
packages: @parcha/agentrun
kind: fix
---
`agentrun login --base-url URL` (or `AGENTRUN_BASE_URL`) typed on a terminal signs in with a device code when the server offers one, as `agentrun login --to URL` does, instead of refusing; off a terminal it reads the token from stdin as before.
- The sign-in first names the server (`Signing in to <origin>.`); when the address to open is on another origin, a line before the code names both. AgentRun cloud's API with its console (`https://console.agentrun.ai`) is the one pair not named.
- On a terminal, a sign-in the server can't give exits as `--to` does.
- Every device sign-in request sends `User-Agent: agentrun-cli/<version>`, so the page that approves the code can say what asked for it.
- The device sign-in reads only the metadata fields it uses: a server's metadata no longer needs an `issuer` or a `scope`, and the authorization request asks for the scope the server's capabilities name, as before.
- A code that expires says to run `agentrun login` again, whichever way the sign-in was started.
