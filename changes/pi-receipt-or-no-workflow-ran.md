---
packages: @parcha/agentrun-pi, @parcha/agentrun-dsl
kind: fix
---
The outer model can no longer pass off its own work as an AgentRun run. A first-run tester twice saw it do the research itself and answer "Complete" and "Supported, High confidence" with no workflow run and no Jev call.
- Every `agentrun` run result carries a `receipt`, the run id that `/agentrun history` lists (the durable tool's `receipt` is its run key). The results of `inspect`, `dry-run` and `load` say `no workflow ran`.
- In a session where the author skill loaded (through its command, or because the model read its SKILL.md itself) or the `agentrun` tool was called, the extension adds its own entry under each final reply, labeled as a host notice and not written by the model: the receipt with the run's model steps, Jev decisions and direct tool calls (for a resumed run, this attempt only; a scripted run says no model or Jev call was made), or `no workflow ran in this turn`. The model's reply is left as it wrote it. A reopened session starts without the notice until the skill loads or the tool is called again.
- The host addendum tells the model to quote the receipt or say no workflow ran, and never to report its own reading or searching as a workflow result.
- The author skill now forbids passing research done while authoring in as the workflow's input, calling a result verified or supported without a judge call in the run, giving a judge file names instead of the material it judges, and adding a code node only to format output (code forces `--trusted`).
