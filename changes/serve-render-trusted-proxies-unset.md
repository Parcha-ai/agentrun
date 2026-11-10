---
packages: @parcha/agentrun-serve
kind: fix
---
`render.yaml` no longer trusts every private address as a proxy. It set `AGENTRUN_TRUSTED_PROXIES=uniquelocal`, so any peer on Render's private network could name its own address in `X-Forwarded-For` and pass the sign-in limit's per-address count (the server-wide budget still held). Render publishes no address for the proxy that reaches a service, so the blueprint now leaves it unset. The owner's first sign-in of a start (the right password) that comes with `X-Forwarded-For` from an address the server doesn't trust logs that address once (`event=forwarded_untrusted peer=<address>`): behind a proxy, the proxy that carried the owner's own request, the address to set `AGENTRUN_TRUSTED_PROXIES` to. A peer without the password can't put its own address there.
