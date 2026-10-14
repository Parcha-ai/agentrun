---
packages: @parcha/pi-vision
kind: feature
---
The planner: `plan(facts, selector, limits, mode)` turns a source into the parts to send, each with the fragment it covers and its pixel and byte budget, and states what it reduced (`as_is`, `downscaled`, `tiled`, `sampled`, `windowed`, `text_only`, `refused`) with the numbers. Pages render at `min(150, floor(72 * maxEdge / long edge in points))` dpi; a long image or page is cut into overlapping tiles of at most 1,568 px; nothing is shrunk under 1,200 px on its long edge, and what would be is refused with `over_budget` and the sizes. A look's requests (`lookRequests`) and its price before the first request (`priceLook`, refused over $0.25 unless the host sets its own cap) come from the plan.
