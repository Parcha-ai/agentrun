---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent, @parcha/pi-durable-disk
kind: feature
---
A message the server writes into a run, a raised cap's follow-up or an approval's resume, can carry its origin
(`{ kind: "server", reason: "cap_raised" | "approval" }`, or `"approval_declined"` with `said`, the words of the person's
message that declined the call). The Timeline then shows it as a phase row, "AgentRun: <its first line>", never as
"You: …", and a declined approval's words as the person's own row beside it; the model reads the same text. A run door's `POST /submit` takes `origin`. On a harness run the
origin is written on the message's user entry. On pi, whose user entry carries no data, a marker entry
(`agentrun.message_origin`, its text) goes first, and the Timeline matches it to the next user entry with that exact text.
The server's row carries `origin: "server"` (a new optional field of a Timeline row), and it counts, as a person's
message does, as the message its turn took: serve reads a run's messages (their arrival, where a stop stands) through one
predicate. pi-durable-agent's timeline exports `MessageOrigin`, `MESSAGE_ORIGIN`, `originOf`, `messageOrigins` (the one
reader) and `isMessageRow`, and pi-durable-disk exports `MESSAGE_ORIGIN_KIND`. A door's `POST /submit` takes exactly the
reasons `cap_raised`, `approval` and `approval_declined`.
