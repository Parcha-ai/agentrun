---
packages: @parcha/agentrun-serve
kind: breaking
---
Behaviour change: on a run a trigger started (schedule, webhook, Slack, GitHub, Composio, email or feed), `email_send` now asks a person before it sends to an address this account has never sent to, even with `email_send` set to allow. Who breaks: an agent a trigger runs that emails new people unattended. Its send now waits for approval, naming them ("someone@example.com: this account has never sent to them"), and with accounts off, where no one can approve, it is refused in those words. To let it through, approve the first send to each new person; the run's later sends to them go unasked.

- Never sent to means no message in the account's own Sent folder (Gmail's Sent Mail), from the account's own address and not a draft, has the address in its To, Cc or Bcc: the exact address, case-blind, as far back as Sent goes. Mail received from someone doesn't count, so a scheduled run replying to a first-time sender asks once.
- What doesn't ask: the account's own address, an address the run already sent to (unasked or approved), on an email run its thread's starter (the From of the message that started it), and every send of a playground or API run, which only the 5-send cap holds, as before.
- An email run on its thread now asks too: it keeps the outside-the-thread ask, and a reply-all that reaches someone the starter Cc'd and the account never wrote to asks, naming them. `scope: "mailbox"` turns the outside-the-thread ask off and exempts no starter.
- `email_file` now refuses Sent and Drafts as targets ("email_file never files into Sent or Drafts: ..."), so a run can't move a draft or someone else's mail into Sent to make an address look written to.
- A Sent folder that can't be read asks, saying "its recipients couldn't be checked against this account's sent mail" and why.
