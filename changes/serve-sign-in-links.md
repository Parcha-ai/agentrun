---
packages: @parcha/agentrun-serve
kind: feature
---
**Accounts are on by default, the first visit makes the owner, and people sign in with an email link**
- Accounts are on unless `AGENTRUN_ACCOUNTS=0`. With no `AGENTRUN_PUBLIC_URL` (as `docker run` gives it), the first person to open the page creates the owner's account and is signed in, with no setup code. With `AGENTRUN_PUBLIC_URL`, setup takes the code from the log as before. A browser's writes must come from the page's origin: the public URL, or `http://localhost:<port>` and `http://127.0.0.1:<port>` without one. The token keeps working for scripts and the CLI. `startServe` takes this as `openSetup` (off by default).
- `POST /v2/people {email, name?, role?}` (an admin's) adds a person. Without a mail server its answer carries the person's one-time `sign_in_link`, which the page shows with a Copy button; with one, the link is mailed and never answered.
- `POST /v2/auth/request-link {email}`: a sign-in link for a person who exists and is not disabled, mailed through `AGENTRUN_SMTP_URL` (smtp:// or smtps://, with its login) from `AGENTRUN_MAIL_FROM`, or else printed to the server's log. It answers before the link is made, with the same answer for every email. An address may ask for 10 links and an email get 3 in 15 minutes.
- A link opens the sign-in page with its token in the fragment, which no server and no mail scanner's fetch sees. Only the page's Continue button posts it to `POST /v2/auth/verify`, which signs the browser in. A link works once, within 15 minutes, and its token is stored hashed.
- A workflow with a code node runs code in the run's process on this machine, so only an admin (or the token) saves one; a member's save is a 422.
- `AGENTRUN_SMTP_URL` and `AGENTRUN_MAIL_FROM` never reach a run's process.
