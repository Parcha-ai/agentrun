---
packages: @parcha/agentrun-serve
kind: breaking
---
Template packages lose three parts that repeated what the server already does. A package that uses one must drop it.
- The `schema` grader is gone. Every completed graded run of a package that declares `output` is now held to its output schema by an `output` verdict, so a case no longer needs a `graders/schema.md`. A case that still has one is refused: "type is one of llm, regex, tool_used, file_exists".
- The `examples/` folder is refused ("a package's folders are skills/, rules/ and evals/"), and GET /v2/templates no longer serves `examples`.
- The `checks` field in agent.md is refused ("no field checks").
- The run read (GET /v2/runs/{run_id}) now serves `input`, the run's input as it was started (null when withheld), and `file_ids`, its files. The console's "Run again" resends both, so a run whose message is over 2,000 characters, has typed fields or was given files now starts again whole instead of being refused.
