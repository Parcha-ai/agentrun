---
packages: @parcha/agentrun-serve, @parcha/pi-browser
kind: feature
---
`web_save {url, path}`, a new host tool, saves one public file (at most 200 MiB) into the run's `work/`, a bare name under `media/`. It downloads through `web_fetch`'s guard, never overwrites, and saves media only when the bytes, the declared type and the extension agree. An agent gets it by naming it. pi-browser adds `publicDownload`, the bytes version of `publicFetch`. A template eval's `web:` fixture takes an optional `save` section.
