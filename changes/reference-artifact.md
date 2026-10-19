---
packages: @parcha/agentrun-harness
kind: feature
---

The recorder takes the agent's report. `report/index.html` in the run's work directory and the files it reaches (`src`, `srcset`, `poster`, stylesheet `href`, CSS `url()`, relative links, transitively) are recorded as blobs, and the manifest gets `artifact { title, entry, files }`. A file the final page does not reach is dropped, and a report that loads a file it does not hold, or that has a script, an `on*` attribute, a `data:` URL, an iframe, object, embed, form, base or meta refresh, refuses the recording. The validator checks the paths, the blobs, the entry and each `data-look`; the gallery's gate repeats the machine-path scan on blobs that are not text. New runtime dependency: `htmlparser2` (MIT).
