---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
`DAYTONA_PUBLIC_EGRESS` is a new optional setting, and most operators leave it unset: unset, nothing changes. Set it only when your self-hosted Daytona target's runners drop every sandbox connection outside an allow list and you run a gate on that list that admits HTTPS by its TLS server name. It names the gate as `<IPv4>:<port>` (the provider option `publicEgress`), and a malformed value is refused when the provider is made. A computer whose network is `open` or a list then has its egress proxy send each tunnel to port 443, an HTTP CONNECT or a SOCKS5 CONNECT, to the gate once every check passes, with the program's bytes unchanged. Plain HTTP and every other port still go to the checked address, and a host the proxy refuses never reaches the gate.
