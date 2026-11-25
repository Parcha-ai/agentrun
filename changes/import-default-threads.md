---
packages: @parcha/agentrun-import
kind: feature
---
`parseHome`'s default `threads` (and the `agentrun-import` CLI's, without `--threads`) is no longer the cores the process may run on, at most 8. It is the fewest of: the cores less one (two on a two-core machine, one on one), 16, and the workers whose heaps fit in the memory still free (the machine's, page cache counted as free, at most the container's limit when one is set) once `readAhead` is set aside. Each worker is counted at 96 MiB; the import's peak grew by about 91 MiB a thread from 8 threads to 16. On a 23 GB home on a 48-core machine (median of 2), 8 threads took 27.5 s at a peak of 1.13 GiB, 16 took 20.3 s at 1.77 GiB, 24 took 17.2 s at 2.39 GiB and 32 took 23.3 s at 2.87 GiB. So a 48-core machine now reads on 16 threads, a 10-core 16 GB laptop on 9 (while 1.85 GiB is free), a 4-core 8 GB machine on 3 (while 800 MiB is free). An explicit `threads` is taken as before, 1 to 64.
