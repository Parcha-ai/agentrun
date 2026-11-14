---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A pi code-mode script's computer calls are on its `codemode` tool call's result row, as a direct computer tool call's are: one `computer_calls` record per call, each with its own `started_at`.
- Each record also names the call's `app`, and each `ui.act` step the element it acted on (`on`: its role, and its name as the last observe read it, at most 60 characters), the chord it pressed (`keys`, only a chord with ⌘, ⌃ or ⌥, or named keys alone) and a `nav` place. A typed or set value is never kept. An element's name goes through the run's redaction.
- Console: a step with computer calls shows how many it made and how many failed; open, each call in words ("select all (⌘A); type into the text box “Pears: 41”"), when it started after the first, and how long it took. `@timeline/computer`'s `callWords` gives the same words to any reader.
- Breaking: a `computer_calls` record now always carries `started_at`; a reader of the old shape that built its own start time from the row's timestamp reads it from the record instead.
