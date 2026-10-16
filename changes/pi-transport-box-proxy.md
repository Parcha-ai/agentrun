---
packages: @parcha/pi-transport
kind: feature
---
The box proxy: the host makes the session's tool boxes. `serveBoxes({ providers, receipts, allow })` holds the host's
providers and their credentials; `proxyBoxes` gives a runner one `BoxProvider` per served provider, each box a handle
named by the host's label, never the provider's id, over new link frames (`box`, `box-answer`, `box-stream`,
`box-stdin`, `box-resume`, `box-unknown`, `box-abort`, `box-ack`), numbered and resumed after a dropped link as the
model proxy's are, and fenced by the runner's epoch. `AppContext.boxes` hands them to the app (for
`TransportHost.providers`); `boxRunner` and `connectHome` take `boxes`; `boxPlace` takes `pool`, serves it on every
runner's link and ends its boxes at `release`. No provider token goes into a box.
