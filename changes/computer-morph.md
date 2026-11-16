---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
A Morph provider: `providerFor("morph", { apiKey })`, or `@parcha/agentrun-computer/morph`. A Morph computer is kind `linux`, an instance started from a snapshot over Morph's REST API, with its lifetime as Morph's TTL (action stop) and every command over SSH through Morph's gateway, as the instance id with the instance's own key (read over REST), so the account's key never goes over SSH. Its image is a snapshot id; `prepareImage()` finds or builds the box image as a snapshot in the key's account (digest `agentrun-box-<recipe hash>`). It has no Archil mount and no desktop yet. Network none, open and a list are init's, since Morph has no egress control. serve reads its key as `MORPH_API_KEY`.
- Conformance: `AGENTRUN_COMPUTER_LIVE_MORPH=1 COMPUTER_MORPH_API_KEY=... npm run conformance -w @parcha/agentrun-computer -- --provider morph`, and the live sweep takes `--provider morph`.
