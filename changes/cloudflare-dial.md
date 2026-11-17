---
packages: @parcha/agentrun-computer
kind: feature
---
A Cloudflare provider (`@parcha/agentrun-computer/cloudflare`, id `cloudflare`): a Linux sandbox in a Cloudflare Container whose computerd dials the server. Cloudflare has no REST call that starts a container, so the operator deploys our relay Worker once from `packages/computer/relays/cloudflare` (Workers Paid; `npx wrangler secret put RELAY_TOKEN`, `npx wrangler deploy`) and pastes its URL and token into Settings as `CLOUDFLARE_RELAY_URL` and `CLOUDFLARE_RELAY_TOKEN`. The relay creates, reads, lists and deletes containers, runs nothing in them, and its alarm keeps a quiet container up and ends it at its backstop. Test connection reads the relay's version and refuses another one with how to redeploy. The conformance module reads `COMPUTER_CLOUDFLARE_RELAY_URL` and `COMPUTER_CLOUDFLARE_RELAY_TOKEN`; a Core run happens inside a public server, as every dial host's.
