---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /runs/{id}/usage` counts a browser charge's seconds when its record sits in a learning round's end-of-run turn and its booking landed later, under a follow-up's claim. The `browser_time` line kept the dollars but read its `quantity` as unknown (null), because the read leaves each round's end-of-run turn out and the charge's record was there. The charge is now found across the whole journal, so the line keeps its seconds and the attempt whose claim wrote it. A charge whose booking is left out with it still adds nothing.
