---
packages: @parcha/agentrun-serve
kind: feature
---
The console's Keys page shows each provider's own icon beside its name, in place of a key icon. The icon comes from Google's favicon service (`www.google.com/s2/favicons`, which redirects to `t0`-`t3.gstatic.com`), so the console now loads one thing from the network, and the page's Content-Security-Policy `img-src` allows those five hosts. The request names the provider's public site and carries no referrer and no cookie of the server's; Google sees the browser's address and which providers the page lists. Offline, or with those hosts blocked, a provider shows its bundled mark (Anthropic, OpenRouter) or the key icon. To keep the console from asking, block those hosts.
