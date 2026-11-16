---
packages: @parcha/agentrun-serve
kind: fix
---
An email trigger no longer skips mail when its filter or `every_s` is edited while its start is still being taken. The start (made, moved to another mailbox, or turned on again) forgets the old cursor and then waits on the mail server; an edit that landed meanwhile dropped the start's result if it changed any field of the source, so the trigger was left with no cursor, and its first poll started watching from then. Now only an edit of where it reads (`account`, `mailbox`) or turning it off drops that start, and such an edit takes its own; an edit of `accept` or `every_s` keeps it, and the mail after it starts runs.
