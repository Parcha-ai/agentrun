---
packages: @parcha/agentrun-serve
kind: feature
---
A run's opening message is saved in its folder as `inputs/message.md`, its `content` byte for byte, beside the files it was given, on every harness. An agent can name that file to a subagent instead of copying a long message into the call. A run with no text `content` gets no file, an upload at that path takes `message-2.md`, and the first message's files line never names it. The bundled code-review package uses it: for a pasted diff, each reviewer's prompt names `inputs/message.md` and the reviewer reads the diff there, so the parent no longer writes the diff out eight times (on a 1,000-line diff that copy alone ran into the model's output ceiling).
