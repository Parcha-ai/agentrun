---
packages: @parcha/agentrun-serve
kind: feature
---
`email_send` asks a person in two more cases, even when it is set to allow:
- after a run has sent 5 emails, each further send asks, saying "this run has sent N emails". This stops two auto-responders that answer each other from looping. The count is the run's own record of sends that went out (a send denied, refused or failed doesn't count), so a pause doesn't reset it.
- on a run an email trigger started, a send that reaches anyone outside that email's thread asks, naming them ("eve@example.com is outside this email's thread"). The thread's people are the account's own address and every From, To and Cc of the thread's messages. A run whose agent reads the whole account (`scope: "mailbox"` on `email_read`), and any run no email started, is held to the cap alone.

The approval says why: its `summary` ends "Asks because …", and the card's arguments carry it as `asked_because`. With accounts off (no one can approve), such a send is refused in those words. A tool's own ask is a new field of the server's tool entry (`asks`), so the gate carries no email code.
