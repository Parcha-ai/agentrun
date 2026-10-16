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
- One node status for every panel (`./node-status.ts`), from durable state: the driver's checkpoint, the keyed layout's
  map item records, failed step records and `pin.failures`; live events only for what is running now. The workflow map
  reads it too, so a run that resumed after a kill, or whose map body is one node, shows its finished items done: before,
  such a map showed every item working at the end, though the driver's checkpoint listed them all done.
