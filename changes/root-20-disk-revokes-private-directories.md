---
packages: repo
kind: fix
---
`@parcha/pi-durable-disk` revokes, with a fenced or deleted run's delegations, the ones its holders keep on their own private directories (`.archil/client-<id>`, listed with no path), when those holders hold nothing else. They block no run; before, every killed client left them orphaned, and they piled up and resurfaced in listings. Its CHANGELOG has the details.
