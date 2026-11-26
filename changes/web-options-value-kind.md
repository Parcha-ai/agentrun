---
packages: @parcha/agentrun-web
kind: fix
---
`createWeb` names a refused `pageGuard` or classifier `policy` by the value's kind ("it was a string"), never by the value. Before, `pageGuard`'s error carried the whole value, uncapped, and `policy`'s carried it as JSON.
