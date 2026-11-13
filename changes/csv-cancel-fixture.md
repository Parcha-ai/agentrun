---
packages: repo
kind: fix
---
Make the CSV learning cancellation test keep its mock batch running until cancellation is requested. Exercise polling before and after the click without racing a wall-clock timer.
