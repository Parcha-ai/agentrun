---
packages: @parcha/pi-durable-disk
kind: fix
---
Pin the Docker image, planned-move example and live-test sandbox setup to Archil client 0.10.0, with SHA-256 checks for each downloaded package. The client verifies server certificates against the operating system trust store and rejects certificates from the compromised eMudhra intermediate authorities. Linux hosts need client 0.10.0 or later and the operating system CA bundle installed (`ca-certificates` on Debian/Ubuntu); rebuild Docker images and sandbox snapshots to use the new client.
