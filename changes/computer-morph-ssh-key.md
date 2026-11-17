---
packages: @parcha/agentrun-computer
kind: fix
---
Morph's first SSH exec no longer fails with "Cannot parse privateKey: Unsupported key format". `GET /instance/{id}/ssh/key` answers a PKCS#8 key (PEM label `PRIVATE KEY`), which ssh2 does not read, so the provider now converts it before the login: RSA to PKCS#1, EC to SEC1, Ed25519 to OpenSSH's own format. An Agent37 `sshKey` in PKCS#8 is converted the same way.
