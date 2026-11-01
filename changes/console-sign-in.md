---
packages: repo
kind: feature
---
The console signs in through AgentRun Server's own routes (`/v2/auth/session`, `/v2/auth/sign-in`, `/v2/setup`, `/v2/auth/sign-out`): the first visit sets the owner's password, later visits sign in with it, and Sign out ends the session. The server's HttpOnly cookie is the session; the console keeps no credential. A server without accounts sends the person to the link it printed.
