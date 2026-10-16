# The scripted run's truth table

SYNTHETIC issues written for the scripted run, in the shape of a real repository's (the maintainers' type labels are the Express repository's: bug, enhancement, docs, question). The scripted judge answers from this table; nothing in it is a real person's text. A live take replaces the scripted answers with Jev's.

Jev labels each issue with one of four types (bug, feature, docs, question) and answers two more questions on every row: *good first issue* and *actionable* (can a maintainer act on the report as written?). Only the type label is scored against the maintainers'; the other two are shown, never scored. A waiting-on-reporter label is a process state, not a type, so no synthetic issue carries one.

The three disagreements are ones a careful reader could make: #107 (labelled a question) reports the docs and the code disagreeing (a bug against the docs, or a question); #109 reports a rejected promise that is dropped (a bug, or the feature it is filed as); and #115 reports behaviour the docs are silent on (a docs gap, or the bug it is filed as). #105, #107, #110 and #117 are reports a maintainer could not act on as written, which the *actionable* column shows. The closing card shows what a run finds, never a tuned 20.

| # | Maintainers' type label | Mapped | Scripted Jev label | Agree | Good first issue | Actionable |
|---|---|---|---|---|---|---|
| 101 | bug | bug | bug | yes | no | yes |
| 102 | enhancement | feature | feature | yes | no | yes |
| 103 | docs | docs | docs | yes | yes | yes |
| 104 | question | question | question | yes | no | yes |
| 105 | bug | bug | bug | yes | no | no |
| 106 | bug | bug | bug | yes | no | yes |
| 107 | question | question | bug | **no** | no | no |
| 108 | docs | docs | docs | yes | yes | yes |
| 109 | enhancement | feature | bug | **no** | no | yes |
| 110 | bug | bug | bug | yes | no | no |
| 111 | enhancement | feature | feature | yes | no | yes |
| 112 | enhancement | feature | feature | yes | no | yes |
| 113 | question | question | question | yes | no | yes |
| 114 | docs | docs | docs | yes | yes | yes |
| 115 | bug | bug | docs | **no** | yes | yes |
| 116 | enhancement | feature | feature | yes | no | yes |
| 117 | bug | bug | bug | yes | no | no |
| 118 | bug | bug | bug | yes | no | yes |
| 119 | docs | docs | docs | yes | yes | yes |
| 120 | question | question | question | yes | no | yes |

Agreement: 17 of 20.
