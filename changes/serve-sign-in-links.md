---
packages: @parcha/agentrun-serve
kind: feature
---
**People sign in with an email link, and accounts are on by default**
- `POST /v2/auth/request-link {email}` sends a sign-in link to a person an admin added: through SMTP when `AGENTRUN_SMTP_URL` (smtp:// or smtps://, with its login) and `AGENTRUN_MAIL_FROM` are set, otherwise printed to the server's log. The link works once, within 15 minutes; its token is stored hashed. `GET /v2/auth/verify?token=` signs the browser in and opens the page, or sends it back to the sign-in page. Every email gets the same answer, so it tells nobody who has an account here; an address may ask for 10 links and an email get 3 in 15 minutes.
- `POST /v2/people {email, name?, role?}` (an admin's) adds a person. The sign-in page has an email box.
- Accounts are on unless `AGENTRUN_ACCOUNTS=0`. On an address that is not loopback they need `AGENTRUN_PUBLIC_URL`: without it, and unless `AGENTRUN_ACCOUNTS=1` asks for them by name, the server starts on its token alone and says why (the container image listens on 0.0.0.0). The token keeps working for scripts and the CLI.
- A workflow with a code node runs code in the run's process on this machine, so only an admin (or the token) saves one; a member's save is a 422.
- `AGENTRUN_SMTP_URL` and `AGENTRUN_MAIL_FROM` never reach a run's process.
