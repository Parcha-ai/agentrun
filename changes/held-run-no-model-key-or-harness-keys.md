---
packages: @parcha/agentrun-serve
kind: fix
---
A held run (`hold: true`) refused its model at its create no longer answers `422 model_key_required` for a missing key on a server whose model gateway holds none: it makes no model call, so it opens and holds its computer. A `model_key` handed with such a run is refused (`422 input_invalid` at `model_key`) as never used. Its claim on a harness recipe billed to its vendor's plan opens none of the keys saved for that harness in Settings → Harness keys, and a runner that starts each run in a process of its own hands that process none. Nor does its claim open the credentials of the MCP servers it is granted, fal's included: nothing can call them, so it carries no MCP tool.
