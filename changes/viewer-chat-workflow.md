---
packages: repo
kind: feature
---
**`apps/viewer`: the chat view's Workflow view**
- A run that ran a workflow has a "Report | Workflow" switch at the top of the chat view's right pane (inside the bottom
  sheet on a phone); a run with none has no switch. The Workflow view draws one graph per workflow run, in run order,
  each node marked with what the run had done there at the replay's time. The drawing is the workflow graph panel's,
  now shared (`src/graph-draw.ts`).
- Every workflow node in the chat view is keyed by its task and its path. Before, nodes were keyed by path alone, so in
  a recording with two runs whose paths collide the second run's node took the first one's conversation label and span.
- The replay's time is the run's end until a press or a drag on the session timeline (a playhead marks it) or the
  view's scrubber sets it; a click on a span still jumps to it. A node's click opens its conversation in the thread,
  else lights its span; the tool call that started a run gets a chip to its graph and is never folded as a command.
- The machine-path scan passes `/root/workflow/...` and `/root/iterations/...`: they are workflow execution paths.
