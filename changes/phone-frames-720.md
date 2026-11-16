---
packages: @parcha/agentrun-computer
kind: feature
---
A phone's live view comes faster and in smaller frames. phoned reads the screen for a watch every 200 ms instead of every second, only while a `screen.watch` call waits, and a read whose pixels are the last one's is neither scaled nor encoded. The phone-harness provider's `watch()` asks for JPEG frames 720 wide when its caller names no width (720 × 1600 on a 1080 × 2400 phone, about 2.2 times fewer pixels than the screen's full size it sent before). The console's Screen tab and the run video take these frames; input coordinates stay the screen's own pixels. A caller's `maxWidth` still wins.
