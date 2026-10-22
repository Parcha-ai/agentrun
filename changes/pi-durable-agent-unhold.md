---
packages: @parcha/pi-durable-agent
kind: feature
---
`@parcha/pi-durable-agent` is no longer held: its manifest drops `"private": true`, so a release publishes it to npm under the `beta` tag, at the workspace version, after `@parcha/pi-transport`. Its README's install lines pin the pi packages to 1.3.0 (pi 1.4 is not supported yet; a later release widens the range). Its quickstart runs in an empty directory after one `npm install` of the package and the pi packages it runs with: CI runs it that way from the packed package (`scripts/stranger/pi-durable-agent.json`), and also runs the README's install line as written, with the packed package in place of `@beta`.
