---
packages: @parcha/agentrun-pi, @parcha/pi-durable-disk, @parcha/pi-browser, @parcha/pi-vision, @parcha/pi-transport
kind: feature
---
Accept pi 1.3: the `@earendil-works/pi-durable` and `@earendil-works/chord` peer ranges now end below 1.4, with the floors unchanged (1.0.4, and 1.1.0 for `@parcha/pi-browser`). pi 1.3.0 pins its own packages to exact versions, so an install is all 1.2 or all 1.3; CI runs every package's whole suite on a 1.3.0 family as well as on 1.2.0, and the README install lines name the pi packages without a version again.
- On pi-ai 1.3, a tool call whose arguments are not a JSON object reaches no tool: pi-durable refuses it and shows the model the text it sent. A durable node's `submit` then spends none of its submissions. Before 1.3 the tool ran with `{}`, so `submit` answered with the schema's violations and counted one submission.
