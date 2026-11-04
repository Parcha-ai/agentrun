---
packages: repo
kind: ci
---
The serve test for setup's count of a big home now checks that the count answers, then stops the server, instead of racing the server's exit against a 3.5 s bound while the count runs. The old test failed on loaded CI runners with correct code (an exit 3.5 s after SIGTERM), because the time a correct count takes to stop and the time a count that reads the sessions for keys takes overlapped. Its result also depended on when SIGTERM landed: a stop before the count's listing ended it before any scan. The home now holds one subagent file of about 20 MB under 5,000 hard-linked names. A count that lists the files answers in about a second. A count that reads them would read about 100 GB and does not answer within the test's 30 s, so the test fails on every run. The test also no longer holds its process open for the full bound after it passes. Test-only: the server is unchanged.
