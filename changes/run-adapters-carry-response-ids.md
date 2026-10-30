---
packages: @parcha/agentrun-adapters
kind: fix
---
A paid request's response ids are kept when their own write is refused. The ids a response's headers give (a gateway's call id, the provider's request id) are written as the headers arrive, before the client gets anything. When that write was refused, for example by a commit that timed out, they were dropped. The model proxy still goes on with the answer and says so once, and the booking now carries the ids, marked `late`, into its own next write: the next request's record, or this request's answer. A request cut off later by the process dying still keeps them. An answer whose record already holds the ids drops the carried copy, so they are never written twice. A process that dies inside that write, or before the booking writes again, still loses them; the request is then booked once, cut, at an unknown cost, with no ids.
