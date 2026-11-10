---
packages: @parcha/agentrun-computer, @parcha/pi-browser, @parcha/agentrun-serve
kind: feature
---
A keyless local browser: the computer package's `local` provider (`LocalBrowserProvider`, kind `browser`) runs this machine's Chrome or Chromium, with no vendor and no key, and pi-browser's new `cdpDriver()` (`@parcha/pi-browser/driver/cdp`) drives it with raw CDP.
- Each browser is one headless Chrome (`headed: true` shows the window) with a throwaway profile and a random debugging port on 127.0.0.1. `connect()` hands over its `ws://` DevTools URL. `release("delete")` ends it and removes its files.
- A supervisor process of its own ends each browser at its deadline, on release, or when Chrome exits, so a run that crashes leaves no Chrome behind.
- Chrome's sandbox is always on: a start as root, or where Chrome cannot start its sandbox, is refused in words. Every request goes through an egress proxy that reaches public addresses only. This machine's loopback, private networks, link-local and the cloud metadata address are refused, and Chrome resolves no name itself, speaks no QUIC and sends no WebRTC UDP.
- Chrome is the `executablePath` option, or `CHROME_PATH` or `PI_BROWSER_CHROME` in the `env` a host passes, or the first on that env's `PATH`. With none, `check()` and `testConnection()` say what to install.
- Its known limits: the debugging port has no auth (any local process can drive it), and the browser is a process of this host isolated by Chrome's sandbox alone. It is for local and development use.
- `ComputerCapabilities.isolation` takes `"host"`, and Settings → Computers lists "Local Chrome" with no key.
- pi-browser's `run` takes a `goto` action (`{"op":"goto","url":"https://..."}`) on every browser. On the local browser `run` takes actions only and refuses code in words. Its snapshot keeps the "frame-node" ids and names each cross-origin frame it could not read. The driver is adapted from Browser Use Pi (MIT, see pi-browser's NOTICE).
