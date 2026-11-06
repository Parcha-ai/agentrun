---
packages: @parcha/agentrun-serve
kind: feature
---
In a sandbox, `read` opens an image (png, jpg, gif or webp) at any absolute path in the run's box, such as a frame rendered to `/tmp`, and returns it to the model as an image of at most 5 MB. The extension and the file's bytes must both say image. The file is read through the box, never from the server. Any other file outside `work/` is still refused, as is any path on the server. `write` and `edit` stay in `work/`, and a runner-placed agent is unchanged.
