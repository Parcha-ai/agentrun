---
packages: @parcha/pi-transport
kind: fix
---
The model link no longer imports its frame encoder from pi-ai, which removed it in 1.3.0 (`@parcha/pi-transport/home`
failed to load there). The package carries its own `FrameEncoder` and `applyFrame`, written to the same wire format as
pi-ai 1.1 and 1.2 wrote, byte for byte: frames kept at rest and a home on an older build still link. The format is
pinned by streams captured from pi-ai 1.2.0 (text, thinking, tool calls, an error and an abort) as test data. Peer
ranges are unchanged.
