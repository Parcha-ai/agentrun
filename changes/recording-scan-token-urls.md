---
packages: @parcha/agentrun-harness
kind: feature
---
The recording scan (the recorder's finish, the follower, the validator and the gallery's gate) refuses a URL that carries a credential: a token-bearing query parameter or fragment, a live-view, debugger or connect URL, a DevTools websocket path, or Kernel's live-view path. The message names the kind and the parameter, never the value. A recording that holds one is not published.
