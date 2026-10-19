---
packages: repo
kind: fix
---
The vision agent example (`examples/vision-agent`) finds its example folder as the one argument that is neither a flag nor the value of a flag that takes one, so `npm run demo:vision -- --live examples/document-check` asks that folder's question over its files instead of silently running the default question over none. The flags that take a value are the host's string options and `--thinking`; a test holds the list to the host's. A second folder, a stray token, or a folder that is not an example is refused before anything starts, with one line and nothing written, where it used to be skipped or to end in a stack trace.
