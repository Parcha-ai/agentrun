---
packages: repo
kind: ci
---
The daily Render walk first asks GHCR, as an anonymous pull, whether `render.yaml`'s image tag is published. When it is not (a release moves the pin before its image is published), the walk makes no service and its report says the tag is missing, instead of paying for a service whose deploy fails at the pull. The Deploy to Render button fails the same way until the image is published.
