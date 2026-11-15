---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
The local server reads and sends email through one account of the owner's (IMAP and SMTP with an app password), saved in Settings → Email and sealed like every other secret.
- `GET`, `PUT` and `DELETE /v2/settings/email` keep the account (presets for Gmail, Fastmail and iCloud, or servers of your own; Outlook is refused in words: it needs a Microsoft sign-in this server does not do yet), and `POST /v2/settings/email/test` signs in to both servers without saving or sending anything. All four are the owner's session's alone.
- An email trigger, `{kind: "email", mailbox?: "INBOX", every_s?: 60, accept?}`, reads the mailbox on a clock and starts a run for each new message its `accept` takes, keyed by its Message-ID. The first check fires nothing. A message this server sent is left. The trigger shows its last check, and turns itself off (`sign_in_refused`) after the mail server refuses the sign-in three times in a row.
- Four tools: `email_search`, `email_read`, `email_draft` and `email_send`. `email_send` asks a person by default, and its approval shows who it goes to and what it says. A run an email started reads only that email's thread unless the agent's `scope: "mailbox"` setting widens it. Every answer stays under the host's result bound.
- New dependencies of `@parcha/agentrun-serve`: `imapflow` (IMAP), `mailparser` (parsing a message) and `nodemailer` (composing one and sending it over SMTP). They load only when the account is tested, a trigger checks the mailbox or a run is given an email tool, never when the server starts.
