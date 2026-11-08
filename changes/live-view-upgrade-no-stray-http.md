---
packages: @parcha/agentrun-serve
kind: fix
---
A run's live view whose browser connection breaks mid-session now just closes the viewer's WebSocket. Before, the server wrote an HTTP "502 Bad Gateway" line into the already-open WebSocket stream when the run's side reset, and its upgrade handler would have written a "500" the same way had anything failed after the stream started.
