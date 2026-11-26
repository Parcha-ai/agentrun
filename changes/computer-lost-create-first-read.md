---
packages: @parcha/agentrun-computer
kind: fix
---
Browserbase and Kernel: a lost create's first read of its request that fails is tried again within the recovery's settle window (at least once while time is left, however short `cleanupMs` is), and the browser is kept when no read answers, where before it was released even when another create's converge had answered it. A read again that misses the lost create's browser or every newer one keeps it too, and on every read, the first included, a newer browser that has ended counts before an older one that runs. A first read that already shows a newer browser ended keeps it at once, with no wait. The search's retries for a vendor that lists a browser late now wait within half of `cleanupMs`, so a short `cleanupMs` bounds the whole recovery. The README gives the vendors' ceilings for a browser left to its lifetime: 6 h on Browserbase, 72 h on Kernel.
