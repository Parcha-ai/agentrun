---
packages: @parcha/agentrun-serve
kind: fix
---
With accounts off, the API token can't write secrets. The console's cookie on a server with no accounts was a MAC of the token, and the printed link carried the token, so anyone holding the token (a run's process, an MCP client, a script) could compute that cookie or fetch it from the link, and save, replace or remove a secret as the console does. Now each start makes a launch code at random and prints the console's link with it (`Open <url>/?launch=<code>`, never the token); opening it gives the browser a console session, an id made at random and kept by the server, and only that session (on a loopback-bound server) writes secrets. A `?token=` link signs no browser in, and a cookie computed from the token is no session. The session lasts until the browser closes or the server stops; the next start prints its own link. A wrong launch code is logged as `auth_failed reason=wrong_launch_code`.
