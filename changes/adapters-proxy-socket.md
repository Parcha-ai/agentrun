---
packages: @parcha/agentrun-adapters
kind: feature
---
**The model proxy listens on a unix socket, and its handler mounts on a host's own server**
- `startModelProxy` takes `socketPath`: the proxy listens there instead of on the loopback interface. The socket is bound in a private directory and made mode 0600 before it is linked to the path, so it is never reachable with a looser mode. A socket that refuses a connection (a crashed host's) is removed. One something answers on, one the probe cannot reach, or a file that is not a socket is refused and left. The path is a hard link, never a rename, so a start that finds it taken is refused rather than replacing it. `close()` removes the socket while the path still holds it. Over TCP the proxy is unchanged.
- `modelProxyHandler` is the proxy's request handling without a listener: `handle(req, res, path)` matches the routes against `path`, so a host's server can mount a proxy under a prefix. `listenLocal` is the listener both use, and `SOCKET_ORIGIN` the origin a request over a socket names.
