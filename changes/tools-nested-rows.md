---
packages: @parcha/agentrun-serve
kind: fix
---
On pi, a script's or `tools_call`'s nested calls now show in the run's timeline, as they do on every other harness. A script now reads a nested call's JSON result as a value.
- Behavior: on every harness, `codemode` and `tools_call` each have their own row, and each call they make has its own row with its result after it. A nested call that waits for your approval shows its approval row, as a direct call does. On pi the nested calls were missing from the timeline: only the script's row showed. They are now written to the same call records Claude Code, OpenCode and Codex runs write, and those records do not count toward pi's model requests or cost. A nested call still waiting when you stop the run reads "Not run: the run was stopped while it waited", as on the other harnesses.
- Behavior: in a `codemode` script, a nested call's value is the tool's structured result when it has one. Otherwise, when its result is one text part that parses as a JSON object or array, the value is the parsed object or array. Otherwise it is the text, as before. What the model sees from the call does not change.
