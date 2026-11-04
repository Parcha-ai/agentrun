---
packages: repo
kind: fix
---
The console's agent editor shows the fetch provider row for an agent that grants `fetch_page`, web_fetch's older name, which the server runs as web_fetch. Before, such an agent had no row, so its fetch provider could be neither seen nor changed in the editor.
