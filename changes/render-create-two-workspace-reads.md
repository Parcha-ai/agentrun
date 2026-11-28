---
packages: @parcha/agentrun-computer
kind: fix
---
Render: a create reads the workspace's whole sandbox listing twice, not three times: once before it makes the sandbox, and once to settle a race after. The first look for a racing create's sandbox, right after Render answers the create, asks for the sandbox's whole name, one page. A request asked again under another run or epoch is still refused as `exists` with no second sandbox made, and two creates of one request that race still leave one sandbox.
