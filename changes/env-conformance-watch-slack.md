---
packages: @parcha/pi-durable-disk
kind: ci
---
The local-disk env conformance cases watch with a 100 ms poll, so pi's fixed 3 s wait for a report keeps seconds of slack on a loaded runner; the product's 1 s watch default is unchanged.
