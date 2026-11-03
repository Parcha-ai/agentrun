---
packages: @parcha/agentrun-serve
kind: fix
---
A run that comes to need its person while no server is up now sends its `run.needs_input` once a server takes it over: the webhook outbox keeps which wait of each run it queued in the same write as the message, and a server that adopts a run queues a wait it stands at that the outbox does not name, under the wait's one `webhook-id` (its stop's, or its question's row's). A wait the previous server already queued is not sent again; one whose outbox write failed before a kill is queued again by the next server. A run waiting when a server is first upgraded to this has no record yet, so its `run.needs_input` is sent once more, under the id it had.
