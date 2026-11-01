---
packages: repo
kind: feature
---
The console edits a workflow agent. A workflow agent's editor opens on a Workflow step that draws its graph, with provider and model chips, the questions, and image and web badges on each decision node. Its JSON redraws the graph as you type, marks what changed against the current revision, and shows the server's validation (`POST /v2/workflows/validate`, or the console's own lint on a server without the route) at each issue's line. A refused save lists every field at its line. The Playground prefills a workflow agent's input with its schema's example (else its fields, empty), and the agents list describes a workflow agent by its shape.
