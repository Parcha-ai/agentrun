---
packages: @parcha/agentrun-computer
kind: breaking
---
E2B computers run on one shared machine-host adapter (`hostedProvider`, `MachineHost`); a vendor now writes only create, get, list, delete, exec and, when it has a file API, upload. Breaking: `E2BProvider`'s `listLabelled`, `killById` and `probeGone`, `diagnoseNetworkNone` and `dist/conformance/e2b-diagnose.js`, `dist/conformance/e2b-sweep.js` and `dist/child.js` (`childCommands` and the daemon read-back, now `dist/hosted/scripts.js`) are gone; sweep a live run with `dist/conformance/sweep.js --provider e2b`.
Breaking: `ComputerProvider.create(spec, context)` takes a required `context.requestId`, the caller's id of the request (serve passes the run's claim, `<run>#<epoch>`). A provider on the adapter names the computer from it, so a retry of the same request returns the computer the first one made instead of making a second, and a retry of one that ended is refused as `exists`; a create without one is refused as `invalid`. Pass a request id on every create.
Two creates of one request on two provider instances converge on the oldest machine (`Machine.createdAt`, else the lowest id) and delete the other. `HostedTimeouts.listedStableMs` (default 1 s) is the listing wait's stability window.
