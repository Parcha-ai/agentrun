---
packages: @parcha/agentrun-computer
kind: feature
---
An Archil computer on Daytona can reach Archil through an egress gateway: set `DAYTONA_ARCHIL_EGRESS` (option `archilEgress`) to `<IPv4 gateway>:<mount lane>:<data lane>`, such as `10.60.0.40:18100:42050`, for a target whose runners reach Archil only through one.
The helper's mount and revoke then take `egress=<gateway>:<mount lane>:<data lane>`: before the archil client runs, `computerd archil-relay` listens on the computer's loopback (127.0.0.1:3129) and an nftables table of the helper's own (`inet agentrun_archil`) redirects root's TCP to Archil's 8100 (the mount endpoint) and 32050 (the file servers) to it, and resets every other TCP to those ports. The relay carries each connection to the gateway's lane for its port with a PROXY v2 header naming the original destination; a relay that cannot reach the gateway closes the connection, so the client reaches nothing. A relay or table that cannot be set up exits 4 and mounts nothing.
Unset, nothing changes. The box image adds `nftables`, so its snapshot name changes; rebuild it with `box/build-daytona.py`.
