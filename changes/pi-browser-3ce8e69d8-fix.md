---
packages: @parcha/pi-browser
kind: fix
---
`@parcha/pi-browser`: the pi coding agent refuses `browser_relaunch` with a `geolocation` when the run's proxies are off, as the pi-durable adapter does: nothing is released and the session goes on. Before, it released the session and relaunched it without the geolocation, saying nothing.
