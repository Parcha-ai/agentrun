---
packages: repo
kind: feature
---
**`apps/viewer`: the workflow graph panel**
- A panel that draws the job's workflow as its nodes and edges (the DSL's graph of the workflow in the manifest's job
  blob), each node marked done, running, failed or not reached at the stop, from the driver's checkpoint, the keyed
  layout's map item records and the live workflow events. A recording whose manifest names no job does not draw it.
- The panel contract gains an optional `showsFor(manifest)`: a panel whose manifest says no is not drawn. The view
  context gains `job`, the job blob's SHA-256, and the shell reads the job blob's JSON for `json(sha)` as it reads the
  result's.
- A node's status is the DSL's `nodeStatus` (`@parcha/agentrun-dsl/graph`, inlined from its source at build time, as
  `workflowGraph` is): `./node-status.ts` keeps only the driver's record it reads (the latest checkpoint's frame and the
  map items' records). The workflow map asks it of each item's part of the record, so a run that resumed after a kill,
  or whose map body is one node, shows its finished items done: before, such a map showed every item working at the end,
  though the driver's checkpoint listed them all done. It asks with `{ item }`, so an item's body is done when the item
  is, whatever the rest of the map has done. An item's part of the record holds the records of the items of a map
  inside it, so that inner map reads what its own items did.
- In the keyed layout, whose checkpoint names no item, the workflow map showed an item as not started when the item's
  own record was its only line (an item a resumed process finished from its journal). Whether an item started is now
  the DSL's `nodeStatus` of its record too, so no panel reads a checkpoint's done paths by hand (`donePathsOf` is
  gone from `./audit-read.ts`). A recording whose task names no workflow (no `agentrun.workflow`
  line) takes the workflow, and the plan the map lays out, from the job the manifest names; before, its items read
  working at the end and its zoomed item listed the steps of another workflow.
- The graph draws a chain's steps and a loop's body inside it, before the step after it. A chain or loop inside a chain
  has two `next` edges, one into its body and one on to the next outer step, and the panel kept only one of them: a
  nested chain's steps were drawn after everything else, out of order.
- The workflow map draws a cell for each item of its map that the record names (the checkpoint's paths and the items' own
  records), as well as each planned item. A map over a list an earlier step built names no item in the input, and a
  process that finishes items from its journal writes no line for them, so such a map drew no cell at all.
