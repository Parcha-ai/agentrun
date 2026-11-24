---
packages: @parcha/agentrun-serve
kind: breaking
---
Behaviour change: on a run a trigger started (schedule, webhook, Slack, GitHub, Composio, email or feed), `email_send` now asks a person before it sends to an address this account has never sent to, even with `email_send` set to allow. Who breaks: an agent a trigger runs that emails new people unattended. Its send now waits for approval, naming them ("someone@example.com: this account has never sent to them"), and with accounts off, where no one can approve, it is refused in those words. To let it through, approve the first send to each new person; the run's later sends to them go unasked.

- Never sent to means no message in the account's own Sent folder (Gmail's Sent Mail) has the address in its To, Cc or Bcc: the exact address, case-blind, as far back as Sent goes. Mail received from someone doesn't count, so a scheduled run replying to a first-time sender asks once.
- What doesn't ask: the account's own address, an address the run already sent to (unasked or approved), and every send of a playground or API run, which only the 5-send cap holds, as before.
- A Sent folder that can't be read asks, saying "its recipients couldn't be checked against this account's sent mail" and why.
- `scope: "mailbox"` no longer exempts an email-started run: it still turns the outside-the-thread ask off, but a send to a never-written-to address now asks. An email run on its thread keeps today's outside-the-thread ask unchanged.
