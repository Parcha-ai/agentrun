---
packages: @parcha/pi-browser
kind: fix
---
`@parcha/pi-browser`: Security: the request observer now watches the Stagehand extension's service worker the way it watches a page, holding and journaling its non-read requests under a `deny` or `ask` action policy, and a local Chrome that `cdpProvider` launches gives that extension a connect policy that allows nothing but its host. `cdpProvider({ chrome: { confineExtension: false } })` keeps Stagehand's own extension directory; a host that dials Stagehand directly passes `target.extensionId`.
