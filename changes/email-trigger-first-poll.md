---
packages: @parcha/agentrun-serve
kind: fix
---
An email trigger starts watching at its first poll, which the server runs at once when the trigger is made, turned on again or edited, instead of a separate start step. A create or a turn-on waits for that poll (10 seconds at most) before it answers, or, when an edit of the trigger's source while it runs drops it, for the poll after the edit, so its answer carries `last_check` and mail after it starts runs. Mail that came while it was off still starts no run, and an edit of its filter or `every_s` still keeps its place. Three things change:
- mail that lands during the create or turn-on call itself, or past the 10 seconds when the mail server is that slow, counts as already there;
- a server that can't be reached at creation writes no history line (the trigger's `last_check` says so); the first check that signs in says "Couldn't check INBOX until now; watching from now: the N messages there won't start runs.";
- a sign-in refused at creation is one of the three in a row that turn the trigger off, as a refusal at any check is.

The note on turning it on again reads as a creation's ("Watching INBOX from now: the N messages already there won't start runs.").
