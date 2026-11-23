---
packages: @parcha/agentrun-serve
kind: fix
---
An `llm` grader in `agentrun-serve eval-template` reads each call's result whole, to 120,000 characters, instead of its first 8,000. A figure deep in a fetched page (past 8,000 characters of a 20,000-character page) used to be out of the grader's sight, so a rubric that checks a cited figure against its source failed a run that had it right. The grader's prompt still stays under 120,000 characters: past that, the longest results lose their middle first, as before. A timeline read with `calls=whole` returns the same whole results, at most 100 rows a page: that is its default, and a `limit` over 100 with `calls=whole` is refused (400).

An answer that is one JSON object and nothing else (after trimming) now counts as its json block, as a last fenced `json` block does: for `output` and `result.output_error`, a grader's `target`, and an `llm` grader's own `{pass, reason}` verdict. An object inside prose, an array or two objects is still no json block.

A run's answer and a call's result as a grader reads it no longer turn compact JSON into `[redacted]` because it runs past 8,192 characters without whitespace: the redactor reads it in pieces cut at the end of a JSON string (an array of numbers, at its commas), and still cuts a held value in it. A held value split by a line break before such a run, or just past the 120,000-character head a grader is shown, now withholds the text whole instead of showing the value's first characters.
