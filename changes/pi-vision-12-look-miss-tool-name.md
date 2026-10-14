---
packages: @parcha/pi-vision
kind: feature
---
A look or a miss at an image the guard met names the tool the model called: `LookEvent.tool` and `MissEvent.tool` are a string, pi's call name through the pi-durable adapter and `CallContext.tool` for a caller of `fit` or `guardResult` (`callContext(api, context, tool)` sets it for a host's own tool), and `read` when a caller names none. With no path in the result, the event's `source` and the record's `args.path` are `a <tool> result`, and `a tool result` when no tool is named.
