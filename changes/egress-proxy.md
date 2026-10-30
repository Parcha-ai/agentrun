---
packages: @parcha/agentrun-adapters
kind: feature
---
A box's egress proxy and its address rule (`@parcha/agentrun-adapters/host`): `startEgressProxy` serves HTTP CONNECT, plain HTTP forwarding and SOCKS5 CONNECT on a 0600 Unix socket, to the public internet only, and `checkAddress` is the one rule it applies. The rule judges the binary address a socket would connect to, so the text a client wrote never matters, and it refuses loopback, private, shared and link-local space, cloud metadata addresses, multicast, broadcast, reserved, benchmarking and documentation blocks, IPv6 outside global unicast, and the host's own interface addresses. An IPv6 address that carries an IPv4 address is judged by the IPv4 inside.
- A name is resolved once, every address in the answer is checked, and the connection goes to exactly the checked address.
- A refusal is answered before any socket opens: 403 with the class as its reason, or SOCKS reply 2. SOCKS5 BIND and UDP ASSOCIATE, an HTTP upgrade, and a Host header that names another host than the request URI are refused by name.
- A redirect is never followed: the client's next request is checked like any other.
- Each run has a cap on connections open at once and a budget of connections in all, each refused by name. The log carries the host, the port, the address and the class, never a path, a query, a header or a body.
