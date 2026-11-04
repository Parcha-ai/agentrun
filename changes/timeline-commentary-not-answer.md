---
packages: @parcha/pi-durable-agent
kind: fix
---
A text answer that its turn goes on from reads as what the agent said (`text_block`, "Agent:"), not as its answer. Codex sends a commentary message ("I'll create `hello.md` …") in a request whose only tool call is its own `exec`, which its host never sees as a call. serve wrote that request as a text answer that stopped, and the timeline labelled it `final_answer` before the tool call that followed. Now a text answer stays the answer only until the same turn shows more with content: another answer, or a call. Then its row is sent again under its id as a `text_block`, in the stored view and the live one. A person's message, or a request with no content (a side request's cost), leaves it the answer. pi's own runs never have such a turn.
