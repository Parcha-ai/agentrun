---
packages: @parcha/agentrun-serve
kind: fix
---
An email trigger starts watching at its first poll, which the server runs at once when the trigger is made, turned on again or edited, instead of a separate start step. Mail that came while it was off still starts no run, and an edit of its filter or `every_s` still keeps its place. Three things change:
- mail that arrives in the moment between the create's answer and that first poll counts as already there;
- a server that can't be reached at creation writes no history line (the trigger's `last_check` says so); the first check that signs in says "Couldn't check INBOX until now; watching from now: the N messages there won't start runs.";
- a sign-in refused at creation is one of the three in a row that turn the trigger off, as a refusal at any check is.

The create's answer no longer carries the first check (`last_check` is null until it lands), and the note on turning it on again reads as a creation's ("Watching INBOX from now: the N messages already there won't start runs.").
