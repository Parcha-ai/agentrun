---
packages: @parcha/agentrun-serve
kind: fix
---
A desktop or phone deleted under a live run (through the vendor's own API, say) now reads "This desktop has been released." on the run's Screen tab, and Take over goes. Before, the tab kept reading "LIVE The agent drives" with Take over until the run ended, because the run's viewer stayed registered after its computer was gone.
- When the viewer's watch ends gone, or can't start because its computer is not found, the runner reads the computer's provider's listing under the computer's own labels (`list`: read-only, and it leaves out a machine that is going). If the computer is not listed (or, for a phone, which is never stopped and kept, is listed stopped: its session closing), the view closes "released": its row is dropped, so `GET /v2/runs/{id}/computer` stops answering `live`. Measured live, the tab read released 2.6 s after the delete on E2B and 14.9 s after it on Agent37 (3.4 s after the computer's not_found, which waits on the 15 s SSH keepalive bound).
- A stream that ends while the provider still has the computer leaves the view as it is, so the tab still shows the run as live.
