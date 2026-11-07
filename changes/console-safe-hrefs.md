---
packages: repo
kind: fix
---
A decision's sources and the images a provider saw are links and images only when their URL is http or https: a `javascript:`, `data:` or `vbscript:` URL from a fetched page, however it is spelled, shows as text, never as a link that runs script.
