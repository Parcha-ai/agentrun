---
packages: @parcha/pi-transport
kind: feature
---
A box can be asked for a network, ports and FUSE, and its facts say what it has: `BoxSpec.network` (`"open"`, `"none"` or `{ allow: [...] }` of domains, wildcard domains and IPv4 CIDRs), `BoxSpec.ports` (each `https` by default, or `tcp`) and `BoxSpec.capabilities` (`["fuse"]`). A provider that cannot give one refuses the spec with `unsupported`; a malformed value is `invalid`.
- `BoxFacts` gains six optional fields, `network`, `ports`, `diskGb`, `startedAt`, `fuse` and `ptraceScope`, so a custom provider needs no change. An absent field never grants anything: `fuse` absent is `false`, `network` and `ports` absent are unknown (a caller that must be sure of `none` or of no exposed port refuses), `ptraceScope`, `diskGb` and `startedAt` absent are unknown. `readFacts(facts)` reads them that way.
- `Box.endpoint(port, context)` (optional) returns where an exposed port is reached: an `https` URL, or a `tcp` host and port, never a provider's id.
- `modalBoxes` implements all of it: `network` and `ports` map to Modal's network and tunnel parameters; `capabilities: ["fuse"]` starts a `vm` and checks, in the box, that a user who is not root can open `/dev/fuse` and a setuid `fusermount` exists, ending a box that fails the check; `diskGb`, `ptraceScope` and `fuse` are what the box reports. `dockerBoxes` takes `network: "none"`. `localBoxes`, `daytonaBoxes` and the Archil exec box refuse anything but `open`.
- The box conformance suite checks the facts that are present.
