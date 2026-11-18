---
packages: @parcha/agentrun-serve
kind: feature
---
console: the Dev tools tab reads as a browser's network panel does. Each row of the table carries its bar on the time axis, the overview above it is compact, and the run's six figures take one line, so more calls show at once.
- Zoom in, or drag across the overview, and the table lists only the calls that ran in that part of the run.
- A call's panel has a Timing section: what it waited before it started, how long it ran, and how long the next request or call took to start.
- The Breakdown view opens with run vitals: first answer, first tool call, largest input, most calls at once and longest pause. It also says when a request read nothing from cache after the cache was written, and when three or more calls to one tool had the same arguments.
- The table is one stop for the Tab key. The arrow keys move from row to row, Enter opens a row's panel, Tab goes into it, and Escape closes it and returns to the row.
- The time axis shows under a forced-colours (contrast) theme, a failed call is striped as well as red, the smallest labels are 11px, and each run-page tab is tied to its panel for a screen reader.
