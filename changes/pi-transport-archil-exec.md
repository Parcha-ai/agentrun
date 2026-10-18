---
packages: @parcha/pi-transport
kind: feature
---
`archilExecBoxes({ client, disk })` (`@parcha/pi-transport/box/archil-exec`): boxes that are directories of an agent's
Archil work disk, each `exec` one serverless Archil call (about 100 ms warm, measured in us-east-1). The SDK is the
host's (`Archil` and a disk from the `disk` package), not a dependency. The limits are stated, not hidden: `BoxFacts` gains
optional `maxExecMs` (300 000: a longer `timeoutMs` is `invalid`) and `liveProcesses` (`false`: no stdin, output after
the call, no program kept between calls). A box with `liveProcesses` false is never a home: the box place refuses it with
`MoveError` code `no_live_processes`. Every exec checks out the box's directory with a queue, so a second process on the
same box waits instead of losing a write; a box's record is a file outside the directory, so `destroy` ends the box at once
even while a command runs. The conformance suite takes `withoutLiveProcesses: "<why>"` and leaves out the live-program and stdin cases,
with one case in their place that carries the reason. A box billed per call gets a receipt with `calls` and `usd_per_call`
in place of `usd_per_second` (`BoxPrice` takes `usdPerCall`; RECORDING.md draft 40). The live suite
(`PI_TRANSPORT_LIVE_ARCHIL=1`) makes its own disk in aws-us-east-1 and deletes it.
