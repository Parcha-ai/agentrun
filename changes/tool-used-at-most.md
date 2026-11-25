---
packages: @parcha/agentrun-serve
kind: feature
---
A template eval's `tool_used` grader takes `at_most: <n>`: it passes on 1 to n matching calls (its `args` filter first, as `count`'s and `at_least`'s do), and beside `at_least` on any number between the two, so "fetched robots.txt at least 3 and at most 4 times" is one grader. A failing grade names the run's count and both bounds ("5 calls of web_fetch; the grader expects at least 3 and at most 4"). An `at_most` under 1 (none is `expect: not_called`'s to say), one beside `count` or `expect: not_called`, or an `at_least` above it is refused in words.
