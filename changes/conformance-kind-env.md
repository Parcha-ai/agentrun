---
packages: @parcha/agentrun-computer
kind: feature
---
The Fly, Cloudflare and Modal conformance modules take a kind, as E2B's does: `COMPUTER_FLY_KIND`, `COMPUTER_CLOUDFLARE_KIND` and `COMPUTER_MODAL_KIND` (`desktop` or `linux`; unset is linux), read by `createProvider()` only. Their dial kits can now run the desktop suite; Modal refuses desktop without dial in its own words.
