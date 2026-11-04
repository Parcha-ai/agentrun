---
packages: @parcha/agentrun-serve
kind: fix
---
A host tool's long output (another harness's `bash`, `read` and the rest) is cut at a character boundary. A cut that fell inside a multi-byte UTF-8 character used to show as `�` at the start of a kept tail or the end of a kept head; the character is now left out whole, and the text stays within the tool's byte limit. A character whose bytes arrive in two output chunks is decoded as one.
