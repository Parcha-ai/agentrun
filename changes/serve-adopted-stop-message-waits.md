---
packages: @parcha/agentrun-serve
kind: fix
---
A message sent while a server ends a stop that the server before it saved is no longer lost. That server died after saving the stop and before its abort reached the run, so the turn still ran. The next server aborts the turn once it sees it, and the run reads stopped (`input_required`) at once. A follow-up sent in that window could reach the run before the abort. pi then withdrew it with the turn, so the message was accepted as a follow-up and never ran, and the run read `working` from then on. A message now waits for that abort as it waits for a stop in flight, then starts the run's next turn.
