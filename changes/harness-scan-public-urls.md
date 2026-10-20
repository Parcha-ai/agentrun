---
packages: @parcha/agentrun-harness
kind: fix
---
The machine-path scan no longer refuses a recording for the path of a public URL. Inside an `http://` or `https://` URL (up to whitespace, a quote, `<` or `>`) a path is the site's, so `https://www.businesswire.com/news/home/2025/en/x` passes, in the recorder's scan, the validator and the gallery gate. A `file://` URL, a bare path (`/home/alice/x`), a Windows profile and a JSON-escaped path still trip, and so does a machine path written next to a URL.
