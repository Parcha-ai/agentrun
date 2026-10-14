---
packages: repo
kind: feature
---
`@parcha/pi-browser` is published from the next release, under the `beta` tag, with the other packages: its manifest no longer says `"private": true`. Its README shows one command that needs no Chrome and no key; its stranger spec (`scripts/stranger/pi-browser.json`) runs that command from the packed tarball in an empty directory with an empty environment, and fails when its output differs from the README's by a byte. It runs on pi-durable 1.1 and 1.2 (`@earendil-works/pi-durable` and `chord` `>=1.1.0 <1.3.0`; `@earendil-works/pi-coding-agent` stays `*`). Its README and `packages/pi-browser/CHANGELOG.md` have the details.
