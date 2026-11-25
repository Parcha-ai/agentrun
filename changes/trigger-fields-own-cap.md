---
packages: @parcha/agentrun-serve
kind: fix
---
In the console's trigger forms, an agent whose `input_schema` has `maxProperties` or `propertyNames` now gets its typed fields, with the message beside them, like any other agent. The forms had fallen back to whole JSON for these schemas: typed fields always carry the message, and such a schema used to refuse `content` with them. Serve now counts and names only the input's own fields against both keywords, never `content`.
