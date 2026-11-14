---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
An agent with an `output_schema` is told the schema, and asked once more when its answer misses it, on every harness (pi, claude-agent, codex, opencode).
- The runner appends the schema to the run's instructions: "End your final answer with exactly one ```json block that matches this JSON Schema:", then the schema.
- When the final answer has no json block meeting the schema, the run gets one more turn in the same session, under the same cap: "Your final JSON did not match the output schema: <why>. Reply again, ending with the corrected json block." It is booked like any other turn and shows on the timeline as a server message. There is never a second retry, and a run that is parked or at its cap ends without one.
- A completed agentic run whose answer still misses the schema serves `result.output: null` with `result.output_error`, why it missed. The TypeScript and Python clients carry the field.
- The console's Report reads an agentic run's `result.output` with its revision's schema, not the answer's text: a string property marked `contentMediaType: "text/markdown"` renders as a Markdown section, at any depth, and a property's `title` names its field. A run that missed says why above the answer as written.
- Templates: applying one no longer copies its answer schema beside a skill's SKILL.md, since the runner now gives the agent the schema itself. A template whose skill reads the schema as a file keeps it inside that skill's folder (code-review's `findings.schema.json` is now `skills/review/findings.schema.json`). The bundled templates' report fields (kyb's `report_markdown`, release-notes' `draft_markdown`, code-review's `summary`) are marked `text/markdown`.
