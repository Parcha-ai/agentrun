# AgentRun's Cloudflare relay

The Worker the Cloudflare provider (`../../src/cloudflare.ts`) calls to create, read, list and delete computers.
Deploy it once to your own account, on Workers Paid, from this folder (Docker must run):

1. `npx wrangler secret put RELAY_TOKEN`
2. `npx wrangler deploy`
3. Paste the Worker's URL and the token into Settings.

What `src/index.ts` does and why is in its header.

## Facts found live

- Wrangler names the container application from wrangler.json's `name` and the class, `agentrun-relay-computer`, even
  under `wrangler deploy --name <other>`. `wrangler delete` removes the Worker and leaves the container application
  behind: find its id with `npx wrangler containers list` and remove it with `npx wrangler containers delete <id>`.
- workers.dev answers Python urllib's default User-Agent with 403 "Error 1010". A script that checks the relay's
  health sends its own `User-Agent`; Node's `fetch` passes as it is.
