---
packages: @parcha/agentrun-serve
kind: fix
---
The launcher (`agentrun-serve`) hands over secrets of any total size. Before, it refused to start once the secrets it names came to more than 4,096 bytes, which a host with a dozen real keys, or one RSA `AGENT37_SSH_KEY`, could reach. A fork of the launcher's shell now writes the pipe as the server reads it, and exits once the last byte is in, or at its next write once a server that exited without reading leaves no read end. No secret goes into an argument, the server's environment or a file, as before.
