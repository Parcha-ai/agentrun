---
packages: @parcha/agentrun-serve
kind: fix
---
Settings → Computers and the new agent's Computer step, from QA on a hosted deploy:
- Docker is no longer shown ready on a server with no Docker daemon (Render and most hosted services run none). `GET /v2/computers` asks the daemon (`docker version`, bounded to 3 s), keeps the answer for 30 s and asks again after, so a daemon that starts later is seen. Docker's sandbox and desktop then say "No Docker on this server: Render and most hosted services run none.", followed by what works in the server's folder mode, naming this server's vendors: for a sandbox with run folders on this server's disk, "A vendor sandbox (Daytona, Modal or E2B) needs Archil turned on in Settings → Workspace."; with Archil on, "Use a vendor computer, e.g. Daytona, Modal or E2B for a sandbox."; for a desktop, "Use a vendor computer, e.g. E2B or Orgo for a desktop.". A run's start and a Docker launch that fails for want of a daemon say the same words.
- A provider's reason in `GET /v2/computers` and its connection test now ends at "Settings → Computers", with no API route in it. The claim's refusal for an API caller still names `PUT /v2/computers/{provider}/keys`.
