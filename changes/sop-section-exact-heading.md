---
packages: @parcha/agentrun-dsl
kind: fix
---
A node's `sopSection` gets the section whose heading line is exactly `## <name>`, also when that line's text occurs earlier in the SOP. Before, the slice started at the first place the heading line's text appeared anywhere, so with `## Data sources` above `## Data`, or a `### Data` inside an earlier section, `sopSection: "Data"` handed the node the other section's text and no error was raised. An SOP in which the heading line's text first occurs at that line is sliced as before.
