---
packages: @parcha/agentrun-harness-codex
kind: fix
---
A host tool's images on Codex are checked before the model is sent them, by the rule claude-agent holds them to: a type written image/<subtype> with no parameters, and base64. One that can't be sent is the call's error, naming the tool and the image, not a request refused later. In code mode, a script's nested tool call sends no image: Codex hands a script an image as its data: URL inside the result's text, so a script that printed it sent the model the base64 as words. The script now gets the tool's text and a line saying how many images were not sent. When Codex's bundled catalog can't be read, the run's note names the binary by its file name only, with no host path and none of the session's own directories.
