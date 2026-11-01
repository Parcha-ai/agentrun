---
packages: @parcha/agentrun-adapters
kind: feature
---
**The model proxy listens on a unix socket, and its handler mounts on a host's own server**
- `startModelProxy` takes `socketPath`: the proxy listens there instead of on the loopback interface. The socket is bound in a private directory, made mode 0600 and only then moved to the path, so it is never reachable with a looser mode. A socket nothing answers on is replaced, one something answers on or a file that is not a socket is refused, and `close()` removes it. Over TCP the proxy is unchanged.
- `modelProxyHandler` is the proxy's request handling without a listener: `handle(req, res, path)` matches the routes against `path`, so a host's server can mount a proxy under a prefix. `listenLocal` is the listener both use, and `SOCKET_ORIGIN` the origin a request over a socket names.
