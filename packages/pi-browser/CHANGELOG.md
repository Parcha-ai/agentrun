# Changelog

## Unreleased

First release of `@agentrun/pi-browser`, versioned with the other packages of the repository it is published from (the release PR dates this section and gives it the workspace version).

- A browser for pi agents: `snapshot`, `run`, `screenshot`, `browser_read`, `browser_relaunch`, `browser_release`, `web_fetch` and `web_search`, with session custody that survives a crash, evidence filed with its SHA-256, typed failures, and no credential in anything a model, a document or a log can see.
- Entries: `.` (the host-neutral core), `./durable` (the pi-durable adapter), `./coding-agent` (the pi coding agent's extension, what `pi install` loads), `./providers/browserbase`, `./providers/cdp`, `./driver/stagehand`, and `./testing` (a fake provider and driver, public on purpose).
- It depends on Stagehand, undici, zod and two HTML packages. `@earendil-works/pi-coding-agent`, `@earendil-works/pi-durable`, `@earendil-works/chord` and `@browserbasehq/sdk` are optional peers.
