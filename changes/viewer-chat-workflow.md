---
packages: repo
kind: feature
---
**`apps/viewer`: the chat view's Workflow view**
- A run that ran a workflow has a "Report | Workflow" switch at the top of the chat view's right pane (inside the bottom
  sheet on a phone); a run with none has no switch. The Workflow view draws one graph per execution (an
  `agentrun.workflow` task), in the order they began, from the task's own workflow, never the manifest's job; each node
  is marked with what the execution had done there at the replay's place. The drawing is the workflow graph panel's,
  now shared (`src/graph-draw.ts`).
- Every workflow node in the chat view is keyed by the execution's run key (`data.input.key`, which its documents join
  on) and its execution path, mapped to its graph node by the DSL's `graphNodeOf`. Before, nodes were keyed by path
  alone, so in a recording with two executions whose paths collide the second one's node took the first one's
  conversation label and span. The call that started an execution is the call of its conversation made before its
  first line and answered after it.
- In a recording with no times (an export from a store), the replay's place is a line of the file, a tool call spans its
  entry to its result and a node attempt its conversation, so such a recording has a timeline.
- The replay's place is the run's end until a press or a drag on the session timeline (a playhead marks it) or the
  view's scrubber sets it; a click on a span still jumps to it. A node's click opens its conversation in the thread,
  else lights its span, else shows the call that started its execution; that call gets a chip to its graph and is
  never folded as a command.
- An execution that has ended shows no node working. From its terminal line on (the task's `state.outcome`), an
  escalation marks the node its `executionPath` names escalated (its own mark and word) and the nodes holding it
  stopped, a complete run's nodes are done, and a failed or aborted run's working nodes are stopped. Its header reads
  the outcome: "complete", "failed", "aborted", or "escalated at <label>: <summary>" (clipped, whole in its title), and
  the counts include the escalated node. Before the terminal line nothing changes. Before, an escalated run's end read
  "chain working" with the node where it stopped shown as not run.
- The workflow graph panel's focus is mapped to its node by `graphNodeOf` too.
- The build inlines a DSL module (`graph.ts`, `item-state.ts`) without its comments: the bundle carries its code, not
  its docs, whose examples of workflow paths read to the machine-path scan as root's home.
