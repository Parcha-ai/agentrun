---
packages: @parcha/agentrun-serve
kind: feature
---
A sixth template package, `upgrade-watch`: each week it lists the version tags of a GitHub repository you depend on, reads the notes of every version after the one you run (which versions those are is decided by version order, never by where one sits in a list), checks every breaking or behavior change against your list of what your project uses from it, and answers `safe`, `changes_needed` (each finding quoted from the notes, linked, with what to do), `up_to_date`, or `incomplete` when any version's notes could not be read or say nothing, never `safe` in that case. A finding is reported every week until you upgrade past it. It needs no sandbox, no MCP server and no search key (`web_fetch` and `read` alone), and writes nothing.
