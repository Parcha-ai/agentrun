---
packages: @parcha/pi-durable-agent
kind: feature
---
`@parcha/pi-durable-agent` is no longer held: its manifest drops `"private": true`, so a release publishes it to npm under the `beta` tag, at the workspace version, after `@parcha/pi-vision`. Its README's quickstart runs in an empty directory after one `npm install` of the package and the pi packages it runs with, and CI runs it that way from the packed package (`scripts/stranger/pi-durable-agent.json`).
