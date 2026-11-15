---
packages: @parcha/agentrun-serve
kind: feature
---
A template eval's `tool_used` grader takes `at_least: <n>` beside `count`: it passes on n or more matching calls (its `args` filter first, as `count`'s do), so "web_search called at least 4 times" holds for a run that searches 5 times. `count` stays exact; a grader gives one of the two, and one that gives both, an `at_least` under 1, or `at_least` with `expect: not_called` is refused in words.
