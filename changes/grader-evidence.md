---
packages: @parcha/agentrun-serve
kind: fix
---
An `llm` grader on a run with large final files now sees what the run sent. Before, the files took about three quarters of the grader's 120,000 characters, and a quarter of that went to a package's own skills copied under `.agents/skills` and a render tool's cache. The two call lists split what was left by their whole sizes, so a fake MCP server's 36 calls got about 2,900 characters and each argument list was cut to about 15. A media template's rubric that checks each clip's prompt then failed "cannot be verified", or passed with no prompt in its input at all.
- Final files under a folder whose name starts with `.` are tool state. `finalFilesOf` reads them after the run's own files, and `fitFiles` lists them by path and size before it cuts a file of the run's own.
- The files never take more than leaves the calls' arguments half the room (or all they need). The fake servers' list gets at least half of what the calls are left (or all it needs).
- A `<cuts>` note, ahead of the evidence, counts each cut: tool-state files listed by name, files cut, calls' arguments and results cut, calls left out, MCP argument lists cut. It tells the grader that what a cut left out was not seen. A list cut to its heads with no call dropped no longer says "and 0 calls in the middle".
- New: a `tool_used` grader's `args_file` names a JSON list the run writes in its work folder. Each entry must be carried by a call of its own (a one-to-one matching, as `args` matches), and the calls must number the list's length or `count`. A missing, malformed or non-list file fails the grader, saying which. `args_file` beside `expect: not_called`, `at_least` or `at_most` is refused.
