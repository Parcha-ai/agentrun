---
packages: repo
kind: ci
---
The pi 1.2 and 1.3 legs have 45 minutes instead of 30. Each runs the whole suite of every package whose pi range accepts the leg's version, and those suites grew: the legs took 20 to 29 of their 30 minutes, the suite step alone 17 to 25. A leg on a slower runner was cancelled by the job's time limit in its next step, which read as that step hanging. No test or check changed.
