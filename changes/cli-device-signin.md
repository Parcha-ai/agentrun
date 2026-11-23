---
packages: @parcha/agentrun
kind: fix
---
`agentrun login --base-url URL` (or `AGENTRUN_BASE_URL`) typed on a terminal signs in with a device code when the server offers one, as `agentrun login --to URL` does, instead of refusing; off a terminal it reads the token from stdin as before.
- The device sign-in's first line names the server it signs in to (`Signing in to <origin>.`). When the address to open is on another origin than the server's, a line before the code says so and names both. That address is not refused, since a self-hosted install may serve its console on another origin. One pair gets no such line: AgentRun cloud (`https://api.agentrun.ai`), whose device page is on its console, `https://console.agentrun.ai`.
- On a terminal, a server that isn't reached, that offers its sign-in over http off this machine, or whose offer is malformed gets the reason before the refusal of a typed token, which still exits 2.
- Every device sign-in request sends `User-Agent: agentrun-cli/<version>`, so the page that approves the code can say what asked for it.
- The device sign-in reads only the metadata fields it uses: a server's metadata no longer needs an `issuer` or a `scope`, and the authorization request asks for the scope the server's capabilities name, as before.
- A code that expires says to run `agentrun login` again, whichever way the sign-in was started.
