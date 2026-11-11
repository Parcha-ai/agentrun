---
packages: @parcha/pi-browser
kind: breaking
---
The `use_website` tool is removed from the durable adapter: no host passed `sites`. Gone with it: `createBrowserExtension`'s `sites` option, the handle's `docs.Children`, the root exports `useWebsite`, `useWebsiteContract` and `localSites`, and the types `SiteInfo`, `SiteRunPort` and `ChildRunner`. A host that wants an agent to hand a task to another agent runs that agent itself.
