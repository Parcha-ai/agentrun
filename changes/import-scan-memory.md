---
packages: @parcha/agentrun-import
kind: fix
---
The totals scanner keeps each reading thread's scanner memory within 8 MiB, outside its heap: its stack and tables, and room for the longest line it scanned. It used to keep up to 64 MiB a thread for a long line, and that memory was not part of the documented bound. A line that would take it past 8 MiB (one over about 6.7 MiB) is parsed whole instead, with the same totals. The README's memory bound now counts this scanner memory.
