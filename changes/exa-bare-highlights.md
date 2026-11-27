---
packages: @parcha/agentrun-web
kind: fix
---
Exa's search now asks for its highlights bare (`contents: { highlights: true }`), as Exa's guidance for agents asks: Exa sizes them to the query, and our snippet cut (3,000 characters) still applies after. `snippetChars` still sends `maxCharacters` when set, and `snippet: "text"` still asks 3,000 characters when it is unset. `EXA_DEFAULTS` no longer lists `snippetChars`, since there is no fixed default.
- An Exa setting given as `undefined` now keeps its default, as an unset one does. Before, `{ pageLinks: undefined }` dropped a fetched page's links, and an undefined `type`, `snippetChars` or `pageVerbosity` sent none.
