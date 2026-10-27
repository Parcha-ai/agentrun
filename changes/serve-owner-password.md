---
packages: @parcha/agentrun-serve
kind: feature
---
**The page is yours: one owner and a password, on by default**
- AgentRun Server is for one person, who signs in to the page with a password. This is on unless `AGENTRUN_ACCOUNTS=0`. With no `AGENTRUN_PUBLIC_URL` (as `docker run` gives it), the first visit sets the password, 12 characters or more, and signs in. With it, setup takes the code the server prints, or the token as the Bearer. A second setup is a 403. `startServe` takes this as `accounts` and `openSetup` (both off by default for a library caller).
- The password is kept as a scrypt hash (N 2^15, r 8, p 1, with a 16-byte salt and its parameters) in `DIR/owner.json` (0600). A session is a cookie signed with HMAC-SHA256 under the key in `DIR/.session-secret` (0600). It holds when it was made, when it ends (30 days, checked from the signed payload) and the session epoch. The cookie is HttpOnly, SameSite=Strict and Path=/, `__Host-agentrun-session` with Secure on https. No run's tool reaches either file.
- `POST /v2/setup`, `POST /v2/auth/sign-in`, `POST /v2/auth/sign-out` and `GET /v2/auth/session` take writes only from the page's own origin with a JSON body. Sign-in tries are limited to 10 per address in 15 minutes, keyed on the connection's peer, never on a header. **Sign out everywhere** ends every session on every browser.
- `agentrun-serve reset-password --data DIR`, run where the data directory is, clears the password and ends every session; the next visit sets a new one. It is never an HTTP route.
- The token keeps working for scripts and the CLI. Every route but capabilities, the contract and health takes the owner's session or the token. The contract's answers do not change.
