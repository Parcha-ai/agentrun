---
packages: repo
kind: fix
---
The run viewer's fan-out draws a grid for each map (`apps/viewer`). A workflow with more than one map, such as a parallel with a map in each branch, drew one map's cells against a legend that counted every map's items, so a finished run read `30 working · -18 waiting`. A map inside a parallel or a route also laid out no plan, and the panel then dropped the workflow, so the DSL could not be asked what the items did: every item read working at the end. Now the workflow is kept whatever it holds, each map not inside another map's body gets its own grid, named by its label when there is more than one, the legend counts the cells drawn, and a zoomed item lists its own map's body's steps. A recording whose lines name no map (no item path, no plan, no map item's record, no workflow with a map) draws no fan-out; before, it drew an empty one.
