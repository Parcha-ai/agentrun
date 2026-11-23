---
packages: @parcha/agentrun-import
kind: fix
---
`parseHome` and `agentrun-import` no longer run out of memory on a large history without a raised heap limit: each request is held as its model and token counts in typed arrays, both during a pass and in the cursors of a `HomeState` kept between passes, and the records already read are indexed by packed keys with no `Map` size cap. A `HomeState` kept by an earlier version is set aside, and the next pass reads every source from its start, as a fresh one would.
