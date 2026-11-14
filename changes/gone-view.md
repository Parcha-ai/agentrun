---
packages: @parcha/agentrun-serve
kind: fix
---
A desktop or phone deleted under a live run (through the vendor's own API, say) now reads "This desktop has been released." on the run's Screen tab, and Take over goes. Before, the tab kept reading "LIVE The agent drives" with Take over until the run ended, because the run's viewer stayed registered after its computer was gone.
- When the viewer's watch ends gone, or can't start because its computer is not found, the runner asks the computer's provider for it by id (`attach`). If the provider answers not_found or gone, the view closes "released": its row is dropped, so `GET /v2/runs/{id}/computer` stops answering `live`. Measured live, the tab read released 2.9 s after the delete on E2B (the console's next poll) and 12.9 s after it on Agent37 (half a second after the computer's not_found, within the 15 s SSH keepalive bound).
- A stream that ends while the provider still has the computer leaves the view as it is, so the tab still shows the run as live.
