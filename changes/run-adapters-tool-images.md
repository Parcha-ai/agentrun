---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude
kind: feature
---
A host tool may answer with images (a screenshot): `HostTool.call`'s result takes `images: [{ mimeType, data }]` (base64) beside its text. The kernel records them with the call's outcome, so a call answered from its record answers with the same images.
- The Claude Agent adapter sends them to the model inline in the tool's result. It checks each image first, a type Anthropic's API takes (`image/jpeg`, `image/png`, `image/gif`, `image/webp`), base64, at most `maxImageBytes` (default 5 MB, `CLAUDE_AGENT_MAX_IMAGE_BYTES`; at most 10 MB), and makes an image it can't send the call's error, by the tool's name and the image (`toolImageProblems`).
- The session's model proxy lets an image through only inline inside a tool's result, and leaves out the note the CLI adds beside it naming the file it kept in its own session directory.
- A session resumed in a new directory still sends the image, from the store.
