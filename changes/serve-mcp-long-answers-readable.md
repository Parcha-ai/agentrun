---
packages: @parcha/agentrun-serve
kind: fix
---
An agent with `read` and no shell (no computer, as on a hosted server) reads an MCP answer too long to read whole to its end, so the code-review template reviews a pull request whose diff is past 60,000 characters without asking for a sandbox:
- The rest of a long MCP answer is filed under the run's `evidence/mcp/<server>/` as lines, a `.txt` (or `.json`, laid out a value a line), never one line of the answer's JSON, which `read` could show only the first 50 KB of before asking for bash. A line past 10,000 characters is broken into pieces of that length, and the note says so. The model reads the answer's first lines, whole, and a note naming the file and the `read` offset that goes on: `[cut at line 664 of 2192 (59980 of 200098 characters); the whole answer is in the run's files at evidence/mcp/github/<file>.txt: read it with offset=665 to go on]`.
- An embedded text resource (GitHub's `get_file_contents` answers a file as one) is read inline with the answer's text, under a `[resource <uri> (<type>)]` line, instead of filing the whole answer as JSON.
- On pi, a host tool's answer reaches the model whole within the host's result bound, as each CLI harness is told; pi's own default (50 KB or 2,000 lines, its head kept) cut off the end of a long MCP answer, where it names the file, and a read's "Use offset=<n> to continue".
