---
packages: @parcha/agentrun-serve
kind: feature
---
serve gains the Workspace port and its local backend, unused until the cutover. A Workspace is one root folder (a run's folder, or an agent's learning folder) and takes paths relative to it only: read with a range, write, append, list, mkdir, grep, remove and exec. A write is atomic and durable on return (a temporary file, fsync, rename, then the folder's fsync), and so are append, mkdir and remove. A path that is absolute, holds "..", ".", an empty segment, a backslash or a NUL, or meets a symbolic link anywhere, the last part included, is refused as ESCAPE. exec takes argv and the whole environment (nothing inherited), binary stdin and stdout, runs in its own process group, and kills the group at its deadline and when it exits. One module now owns the folder layout (a run's folder and an agent's learning folder). A conformance suite holds every backend to the same answers. No code path uses any of it yet.
