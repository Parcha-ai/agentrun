---
packages: @parcha/agentrun-computer
kind: breaking
---
The Docker provider's egress proxies (network allow and open) now sit on a bridge of the provider's own, `agentrun-egress`, with inter-container traffic off, not on Docker's default bridge. There, another workload's container with `NET_RAW` could ARP-spoof the gateway a proxy goes out through. The first allow or open `create` makes the bridge, and later ones reuse it. A network of that name made otherwise (inter-container traffic on, internal, not a local bridge, or without the label `agentrun.computer.egress-network=1`) is refused in words, and nothing is made. A proxy on any other network reads back as other, so an allow or open computer made before this change reads back as other, and attach refuses it. Who breaks: a caller that attaches to a Docker computer with network allow or open made before this change, who deletes it and creates it again.
