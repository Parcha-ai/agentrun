---
packages: @parcha/pi-vision
kind: feature
---
The `report` skill grounds the page before it writes it. Each finding, each row and the answer is put to Jev as a text judgment (`vision.judge` with no image): the texts it shows as `claims` and what the looks it cites read as `evidence`, one noul question for each text asking whether the evidence states every name, time and number in it. A text that is not grounded stops the script, naming it, and is rewritten from what the looks read, re-cited, or dropped; it is never kept as written. What was heard is cited to the transcribe look (`hear()`), the only evidence for a said name, time or number. `hear()` also records the recording it heard as covered, so it cannot be listed as not checked. The skill's check refuses any text that was not judged as written. `test/binaries/report-skill.test.mjs` runs the step on a fake Jev port and shows a row with an unread name refused and the same row passing once a look it cites gives the name.
