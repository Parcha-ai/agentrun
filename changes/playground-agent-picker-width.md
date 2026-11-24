---
packages: @parcha/agentrun-serve
kind: fix
---
The API playground's Agent picker shows an agent's name whole. The field was 14rem wide whatever the names, so a longer name was cut with an ellipsis beside an empty row. The field is now as wide as its longest agent's name needs on one line, and keeps that width whichever agent is picked (the console's `Picker`, `steady`, as the operation picker above it). On a phone it is held to 60% of the window's width and cuts a longer name with an ellipsis. A real-browser flow (`playground-agent-width` in `npm run test:e2e`) measures it at 1280 and 390 px.
