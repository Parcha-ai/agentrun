# telemetry.agentrun.ai

The Cloudflare Worker between AgentRun's anonymous usage counts ([docs/telemetry.md](../../docs/telemetry.md)) and
PostHog's US cloud. It takes one event at a time on `POST /i/v0/e/` and checks it is one of the server's three events
under the project's key. It rebuilds the event from the documented fields and sends that to `us.i.posthog.com` with
`content-type` as its only header. None of the request's headers go on (no `X-Forwarded-For`, `CF-Connecting-IP`,
`X-Real-IP`, cookie or user agent), so PostHog never gets the server's address. It keeps nothing and logs nothing
(`observability` off). Anything else is refused with a 4xx and goes nowhere.

`packages/serve/test/telemetry-proxy.test.mjs` sends the server's own event through `handle` and checks what leaves.
It also checks that `wrangler.json`'s key and route match the server's `TELEMETRY_KEY` and `TELEMETRY_URL`.

## Deploy

From this folder, signed in to the Cloudflare account that holds the agentrun.ai zone:

```sh
npx wrangler deploy
```

The `custom_domain` route makes the `telemetry.agentrun.ai` record and its certificate. That's the one write on the zone.
Workers Free covers it: each server sends one or two events a day.

Check it: `curl -s -o /dev/null -w '%{http_code}\n' https://telemetry.agentrun.ai/` answers 404, and a GET of
`/i/v0/e/` answers 405.
