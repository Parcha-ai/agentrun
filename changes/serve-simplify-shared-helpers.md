---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: ci
---
Code that was written more than once in serve and the timeline now has one copy, with no change to any request, answer or message:
- serve builds the test switches a run's process gets once, at start, instead of passing each one through the run manager as a separate option. `startServe`'s options are unchanged.
- One helper builds the "The body keeps no field" refusal that 8 routes wrote by hand; one per-key queue serves both uploads' commits and the learning folder; one wait-until-deadline serves both waits in a run's start; the inline file types come from the same table as the file types; the install hint for a harness that cannot load is built in one place for claude-agent and codex; the count of a workflow run's answered llm calls is one function for its record and its cost.
- The timeline reads a tool result's text only for a tool that reads its outcome from that text.
- A recovered run with nothing learned no longer removes two paths that are not there.

One wait ends sooner, and nothing else about it changes: a stop that waits for a run's rows to catch up wakes when the rows change, not on the next 100 ms tick. It still ends at the same deadline.
