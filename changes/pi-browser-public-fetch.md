---
packages: @parcha/pi-browser
kind: feature
---
The public-host guard under the coding agent's HTTP backup is exported from the package's root: `publicFetch(url, { lookup?, fetchImpl?, signal?, maxBytes? })` follows at most 5 redirects, resolving each hop, refusing it when any address it resolves to is private (`isPrivateAddress`) and dialling it at the address checked (`pinnedLookup`), and returns the final `{ url, status, contentType, body }`, the body read only for a 2xx text answer and capped at 5 MiB; `readPage(html, url)` gives a page's title, its text as markdown and its absolute http(s) links. A scheme other than http(s) is now refused on the first hop as well as on a redirect. `httpBackup` is built on them and behaves as before.
