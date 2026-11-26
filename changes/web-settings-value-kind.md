---
packages: @parcha/agentrun-web
kind: fix
---
A provider setting its check refuses is named in the problem line by the value's kind ("it was a string", "a list", "an object", "null"), never by the value itself. Before, the line, and the error `createWeb` throws with it, carried up to 60 characters of the value, so a key pasted into the wrong setting showed in it.
