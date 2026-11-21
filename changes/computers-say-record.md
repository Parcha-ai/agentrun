---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
`GET /v2/computers` says per kind whether a run of it can record its screen on this server, and the console's Recording switch reads that alone.
- Public API addition: each of `kinds[]` carries `record`, `{available: true}` or `{available: false, why}`. A desktop, a phone or a browser is available when this server has `ffmpeg` on its PATH (read at each call, as a save of `computer.record: true` checks it); without it, each says "ffmpeg isn't installed on this server (no ffmpeg command on PATH)". A sandbox and no computer are never available, in their own words. The TypeScript and Python clients' `ListComputersResponse` gain it.
- The agent editor's Computer step shows the Recording switch for every kind but no computer, from the kind's `record`: where a run can't record here, the switch is off and disabled with the server's words for why (a saved `record: true` can still be turned off). It used to show the switch only for a kind whose `settings` list `record`, and offered it on a server with no ffmpeg until the save was refused. A switch of kind or provider drops `record: true` where the new kind can't record, in the same words.
