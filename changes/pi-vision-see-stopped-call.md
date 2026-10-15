---
packages: @parcha/pi-vision
kind: fix
---
A `vision.see` call that its code-mode script stopped (a deadline or an abort) files no miss and tells `onMiss` nothing: a path read that failed because the call was cancelled was filed as an `unreadable` miss of that file. The call now rejects with the stop's reason. The eyes request already stopped with the script, on pi-codemode 1.1, 1.2 and 1.3 alike: nothing is kept, filed or told for a request stopped before its answer, and the same call asked again pays once.
