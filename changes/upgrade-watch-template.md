---
packages: @parcha/agentrun-serve
kind: feature
---
A sixth template package, `upgrade-watch`: each week it reads what a GitHub repository you depend on released since the version you run, checks every breaking or behavior change in the release notes against your list of what your project uses from it, and answers `safe`, `changes_needed` (each finding quoted from the notes, linked, with what to do), `up_to_date`, or `incomplete` when a release's notes could not be read, never `safe` in that case. It needs no sandbox, no MCP server and no search key (`web_fetch` alone), and writes nothing.
