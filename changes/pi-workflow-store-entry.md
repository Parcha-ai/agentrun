---
packages: @parcha/agentrun-pi
kind: feature
---
**`@parcha/agentrun-pi/workflows`: save, load and list saved workflows against a directory the host passes**
- `WorkflowStore` (with `WorkflowStoreError`, `StoredWorkflow` and `WorkflowRevision`) is the store the `/agentrun` extension keeps for its project
  directory, now a public entry that loads nothing from pi. `new WorkflowStore(projectDirectory)` takes a project directory, never the workflows
  directory itself: records live in `<projectDirectory>/.pi/agentrun/workflows/<name>/`, so the extension (which keeps using its `ctx.cwd`) and a host
  that passes the same directory read each other's records. `save(name, workflow)` publishes an immutable revision, `load(name, digest?)` returns
  the given revision or the last one saved, and `list()` returns every revision, newest first.
- Nothing about the format or the checks changes: real directories and regular files only (a symbolic link in the path or among the records is refused
  with `unsafe_path`), the record's metadata and its SHA-256 are checked on every load, and a `<name>/` directory copied into the workflows
  directory loads.
