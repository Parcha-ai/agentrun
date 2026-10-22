---
packages: @parcha/pi-browser
kind: feature
---
`@parcha/pi-browser`: a new entry, `@parcha/pi-browser/providers/chrome-args`, exports `chromeArgs()` (the local Chrome's flags, with `--remote-allow-origins` narrowed to the one extension Origin) and `extensionOrigin()`, for a host that starts its own Chrome for Stagehand and should not copy the list. The README names the action-policy refusal under the pi coding agent.
