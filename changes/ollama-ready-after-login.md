---
packages: @parcha/agentrun-serve
kind: fix
---
A model Ollama lists after the server started no longer shows as the default with capabilities still saying no run is ready: a request that refreshes the login now reads what a run needs from the new listing too, as a capabilities request does.
