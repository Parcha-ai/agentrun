---
packages: @parcha/agentrun-serve
kind: fix
---
An agent's `max_tool_calls` counts every call a running tool makes, so a script can no longer run past it. Before, on pi, a `codemode` or `tools_call` call took one call of the budget and its nested calls took none: one script could run any number of tool calls for up to 600 s. Since `codemode` is offered on every pi run, that was every pi run with a budget.
- Each nested call (a `codemode` script's, a `tools_call`'s, a script of pi's code mode on a desktop or phone) counts as a call the model made, and the call that made it counts as one too, as before. Past the budget a nested call is refused before it is sent, in the budget's words, and the script ends there; the script's result and its timeline row say why.
- The gate counts every call itself, from the run's journal: the model's calls from the conversation's entries, the nested ones from the calls the budget let through. A script run again after a crash counts each of its calls once.
- A script of pi's code mode now reads a refused call's words (the gate's, the budget's) in its error, never "Tool read failed".
- The cap's wrap-up still lets a running script's calls through, and the cap still refuses a paid call that does not fit, as before.
- Claude Code, Codex and OpenCode are unchanged: an agent with `max_tool_calls` on them is still refused at save.
