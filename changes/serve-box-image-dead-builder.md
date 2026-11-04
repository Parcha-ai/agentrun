---
packages: @parcha/agentrun-serve
kind: fix
---
A server killed or stopped while it builds or pulls the Docker box's image no longer leaves a run waiting on it for ten minutes and then failing with Docker's own error. The image's record names the server that wrote it (its pid and start time, as the box sweep checks a box record's writer). A run whose first box finds that server gone fails its call at once: `its image … is not ready: the server stopped while building it: restart the server to build it again`. The next start builds it again, as before.
- A build or pull that fails is tried once more, 5 seconds later, by the same server. Meanwhile the box stays `preparing`, its `reason` saying what failed (`trying once more: <the failure in words>`). One that fails again is `unavailable` with the reason, as before. One that ran out of time is not tried again.
- The serve README's recipe says `out.txt` names the image's Debian, with no version.
