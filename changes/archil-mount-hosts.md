---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
An Archil mount can pin the hosts its archil client dials: `hosts` on a `{ kind: "archil" }` mount (and on serve's `PUT /v2/workspace/archil`), an object of at most 16 lowercase DNS names to IPv4 addresses, such as `{ "mount.example.internal": "10.0.0.10" }`, for a computer whose egress reaches Archil only through a private address (an SNI-passthrough proxy) while TLS is still checked against each name. The image's root helper (`box/agentrun-archil`) takes them as `<host>=<address>` after the folder, checks them by the same patterns `archilRefusals` uses (`ARCHIL_HOST`, `ARCHIL_ADDRESS`), and writes them into its own block of the computer's `/etc/hosts`, as root, before the client runs; it refuses (exit 4, nothing mounted) where `/etc/hosts` is not root's alone, so the tool user can change no pin. Without `hosts`, nothing changes and `/etc/hosts` is not touched.
- The helper's sha256 changes, so an image made from an earlier `box/` fails the mount's preflight: build the Daytona snapshot, Modal image or E2B template again.
