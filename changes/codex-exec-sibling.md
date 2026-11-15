---
packages: @parcha/agentrun-harness-codex, @parcha/agentrun-kernel
kind: fix
---
On Codex in code mode, a tool call that finished in the same script as a call waiting for approval now keeps its whole result when the run goes on. Before, the script was cut when the run paused, and on the resume the model got each finished call's result cut to its first 2,000 characters, with a note saying the output of those calls was not shown. So it ran a long read again.
- A finished call's result, or a failed call's error, comes back as the script got it live: up to the same 120,000-character bound every tool result has, with the usual line saying where it was cut past that.
- The recovered script output as a whole stays within that bound plus 2,000 characters for the words around the results. Past it, every result in it is cut to the same share, each keeping its start and its last line (a long MCP answer's last line says where the whole answer was filed) and saying where it was cut. Every call's outcome is still told, unless the script made so many calls that their lines alone pass the bound: then the output is cut with the same note, and the recovery note says only the calls still in it are shown above.
- The recovery note says a finished or failed call's outcome is in the output of the script that made it, instead of "not shown here". A call whose outcome is not in that output (one cut mid-way) keeps the old words.
- `recoverySystemNote` takes the calls whose outcome is already shown as an optional second argument. Without it the note reads as before, so Claude Code, OpenCode and pi are unchanged.
