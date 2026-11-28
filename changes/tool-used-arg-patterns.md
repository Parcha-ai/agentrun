---
packages: @parcha/agentrun-serve
kind: feature
---
A `tool_used` grader's `args` takes `{"$pattern": <regex>}` for a value, as a fixture's `when` does: it matches a call's string argument the regex matches whole (`expect: not_called` with `args: { path: { $pattern: '(?!skills/).*' } }` fails a run that read anything outside `skills/`). A pattern that is no string, does not compile, or sits beside another key is refused when the case is read. The code-review template's `off-by-one` case checks "no repo reads" with two such graders (no `bash` call; no `read` outside the skill's folder and `inputs/message.md`) in place of a model grader, which failed a clean run when the run's trace was too long to show whole.

Every `$pattern` test, a grader's or a fake's `when`, now runs in a worker thread for at most 2 seconds. Before, a pattern that backtracks without end (`(a+)+b` on forty a's) held the grade, or the fake answering the call, indefinitely. Stopped at its limit, it fails the `tool_used` grader whatever `expect` says, and the fake answers the call with an error naming the limit.
