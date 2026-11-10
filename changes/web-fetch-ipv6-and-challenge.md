---
packages: @parcha/pi-browser, @parcha/agentrun-serve
kind: fix
---
`web_fetch` refuses IPv6 addresses that carry an IPv4 one a relay can reach: 6to4 (`2002::/16`) and Teredo (`2001::/32`), as well as the documentation (`2001:db8::/32`) and discard-only (`100::/64`) ranges, so a page cannot steer a read to the owner's loopback or network through them. A host that answers with a bot-protection challenge (Cloudflare's "Just a moment" page and the like) is now said to have refused an automated read, naming what reads such pages (the web provider, Parallel, when the server holds its key), instead of only "the page answered 403".
