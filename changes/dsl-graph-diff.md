---
packages: @parcha/agentrun-dsl
kind: feature
---
`@parcha/agentrun-dsl/graph` exports `graphDiff(prev, next)`: what changed between two graphs of a workflow, such as two saved revisions of one, as `{ added, removed, changed, moved, edges: { added, removed } }`. A node is the same in both when its `(kind, label)` is unique in each graph, so a step inserted before others reads as one added node and the steps after it moved, never as a run of changes; a node whose `(kind, label)` repeats, or is in one graph only, is matched by its path, and the same path with a new kind or label is changed. Added nodes and edges carry their paths in `next`, removed ones their paths in `prev`. The module still imports nothing.
