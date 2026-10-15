---
packages: @parcha/pi-browser
kind: feature
---
`@parcha/pi-browser/recorder`: `exportFrameTracks` turns the recorded frames into one `frame.track` line per session: a WebM (VP9, constant `fps`, default 10) plus an index that maps run time to video time across gaps, with a slate while a gap lasts. `handle.drain(harness, ctx, signal?)` on the pi-durable adapter's handle resolves once no browser release is still running, so a host waits for it before it closes the harness. The index exports custody's vocabulary by name (`CustodyPort`, `AttachedSession`, `ToolOutput`, `BrowserFailureError`, `BrowserDriver`, `DriverFactory`, `DriverOptions`, `Overrides`) so a host can write its own tool.
