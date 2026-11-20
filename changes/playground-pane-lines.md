---
packages: @parcha/agentrun-serve
kind: fix
---
The console's API playground rules the Request pane and the Code/Response pane at the same heights: the line under
their headers and the line above their footers (Send request, the code's note, Open this run) run straight across the
divider instead of stepping at it. The footer's "Sends a real request to this server." note wraps beside the buttons
instead of pushing them onto a second row.
