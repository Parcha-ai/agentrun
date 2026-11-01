---
packages: repo
kind: fix
---
The validator sweep no longer dies on a torn capture. Test files that validate the same workflow at once wrote the same capture file with bodies of different lengths, and the interleaved writes could leave the longer body's tail after the shorter JSON, which the collector then failed to parse. Each capture is now written to a temporary file and renamed into place, so the last writer wins whole, and the collector skips any temporary file a dead process left behind.
