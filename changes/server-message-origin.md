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
pi-durable-agent's timeline exports `MessageOrigin`, `MESSAGE_ORIGIN`, `originOf` and `messageOrigins` (the one reader), and
pi-durable-disk exports `MESSAGE_ORIGIN_KIND`.
