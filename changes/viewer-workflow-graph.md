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
  own record was its only line (an item a resumed process finished from its journal): that record now marks its cell
  started. A recording whose task names no workflow (no `agentrun.workflow`
  line) takes the workflow, and the plan the map lays out, from the job the manifest names; before, its items read
  working at the end and its zoomed item listed the steps of another workflow.
