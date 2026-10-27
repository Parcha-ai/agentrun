---
packages: @parcha/agentrun-serve
kind: feature
---
Accounts, behind `AGENTRUN_ACCOUNTS=1` and off by default: with it unset, serve answers exactly as before and makes no new file. Switched on, people sign in with an email and a password, kept by Better Auth 1.7.14 (pinned exactly) in `DIR/auth.sqlite` (0600) with its secret in `DIR/.auth-secret` (0600, or `AGENTRUN_AUTH_SECRET`). The server's token and the page's cookie keep working beside them.
- First run: with no owner the log prints `Set up this server: <url>/setup#code=<code>`, a code good once, for 30 minutes, until five wrong tries or the next start. `POST /v2/setup` makes the owner and signs them in; the token as the Bearer stands in for the code, and `AGENTRUN_OWNER_EMAIL` with `AGENTRUN_OWNER_PASSWORD_FILE` makes the owner at start.
- The address every link and the cookie come from is fixed at start: `AGENTRUN_PUBLIC_URL` (an origin), or the loopback address; on another address without it, the server does not start. The cookie is HttpOnly and SameSite=Strict, `__Host-agentrun-session` on https; a session lasts 7 days idle and 30 at most.
- Only these of the library's endpoints answer under `/v2/auth`: `sign-in/email`, `sign-out`, `get-session`, `change-password`, `revoke-other-sessions` and `update-user` (the name only). No answer carries a session's token, which stays in the cookie. A write a cookie signs in needs this server's Origin and a JSON body.
- Two roles: every route there was is a member's. This server's own routes `GET /v2/me`, `GET /v2/people` and `PATCH /v2/people/{id}` (an admin's: a role, or disabled) and the activity log: who made each revision (`by` on the revision list), `GET /v2/runs/{id}/activity` and `GET /v2/activity?agent=`. The contract's answers and capabilities do not change.
