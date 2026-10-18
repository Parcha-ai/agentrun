---
packages: @parcha/pi-vision
kind: fix
---
The `find` skill names each search by one word (letters, digits and dashes, like `.find/umbrella`), and its first step refuses any other name before it asks anything: the folder goes into every path and shell command as it is, so a name with spaces or quotes broke the paths the steps handed to `vision.judge`.
