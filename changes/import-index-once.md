---
packages: @parcha/agentrun-import
kind: fix
---
`parseHome` holds each file's records once. A file read on the calling thread adds its records straight to its source's index, where it used to build an index of its own and copy it in when the file ended. A read that fails partway takes its records back out, so the index is left as it was. A file read on a worker thread brings back the worker's index, and the larger of the two indexes now keeps its arrays while the smaller one's records are added to it, so a big file's records are no longer copied. On a synthetic home with one 1.3 GB Claude Code file (1.26M requests), peak RSS fell from 622 to 494 MiB with `threads: 1` and from 858 to 734 MiB with 4 threads (medians of 3). The totals are byte-identical.
