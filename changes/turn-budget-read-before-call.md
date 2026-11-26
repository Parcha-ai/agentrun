---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A pi session opened again in a turn now reads the turn back from its conversation before a call the model made runs, not after: a pi-native tool (bash, web_fetch, a subagent) whose read fails is blocked before it does anything, where before it ran and its result was replaced by an error, inviting the model to run it again.
- A session that read its own answer never reads the turn back, so a store that cannot read blocks none of its calls.
- A call pi reruns after a crash (its intent stored, so the read happens after it) keeps what it did when the read fails, held to the window's bound alone, instead of an error.
- The words a call gets when its turn could not be read are plain: the store's own error is no longer in the model's transcript.
- A tool that nests calls (a code-mode script) whose result's length the session's journal could not keep halts its drive, as an effect's failure does, so the harness is never handed that result.
