---
packages: @parcha/pi-vision
kind: feature
---
The pi-durable adapter writes a result's blocks under both `output` (pi-durable 1.2) and `content` (1.0 and 1.1), and reads `output`, else `content`: on 1.2 a result with only `content` reaches the model empty, and the guard would never see another tool's images. `piResult` returns both keys.
