---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-codex
kind: fix
---
Two fixes to how a Codex code-mode `exec` reads after a park or a crash, and one to pi's wording. A Codex exec's end row now sorts after the rows of the calls its script made: a crash leaves the exec open on the run's record, and Codex's recovered answer to it ends it after the resume. An exec whose call parked on a person's approval and then ran reads ok, with the stopped-and-resumed text, as a codemode script that parked reads on pi and claude-agent, never failed. An exec cut off mid-call still reads failed, after its cut call's row. On pi, a script's call a crash cut off now reads "interrupted: the process running it stopped before it reported an outcome; it may or may not have taken effect", the words claude-agent, opencode and Codex already give it.
