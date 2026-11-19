---
packages: @parcha/agentrun-computer
kind: feature
---
The Fly, Cloudflare, Modal and Daytona conformance modules take a kind, as E2B's does: `COMPUTER_FLY_KIND`, `COMPUTER_CLOUDFLARE_KIND`, `COMPUTER_MODAL_KIND` and `COMPUTER_DAYTONA_KIND` (`desktop` or `linux`; unset is linux), read by `createProvider()` only. Their dial kits can now run the desktop suite; Modal and Daytona refuse desktop without dial in their own words.
