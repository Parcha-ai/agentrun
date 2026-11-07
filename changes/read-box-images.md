---
packages: @parcha/agentrun-serve
kind: feature
---
In a sandbox, `read` opens an image (png, jpg, gif or webp) at any absolute path in the run's box, such as a frame rendered to `/tmp`, and returns it to the model as an image of at most 3.75 MiB, so that as base64 it fits the 5 MiB the strictest platform takes. The extension and the file's bytes must both say image. The file is read through the box, never from the server, and the box sends at most one byte past the bound, so a larger file is refused without the server ever holding it. On another harness (claude-agent, Codex, OpenCode) the image reaches the model as an image too. Any other file outside `work/` is still refused, as is any path on the server. `write` and `edit` stay in `work/`, and a runner-placed agent is unchanged.
