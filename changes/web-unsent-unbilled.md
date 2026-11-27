---
packages: @parcha/agentrun-web
kind: fix
---
A paid web request (keyed Exa's and Firecrawl's search and fetch, Parallel's search and extract) that never left the process is no longer billed at its fee. A call already stopped asks for no payment and starts no search backend. A request stopped before its send began, or whose fetch failed while connecting (`ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT`, or a TLS certificate or handshake error), settles at $0, and its receipt line reads `not billed (not sent: <code>)`. A reset socket, a timeout, a stop after the send began or a broken answer is still billed at the fee.
