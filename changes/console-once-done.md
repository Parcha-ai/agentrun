---
packages: repo
kind: fix
---
A one-time schedule that has run (a one time with no next time, whose last firing is for that time and started a run, as served) reads "Done · ran <when>" on the Triggers list and its page, with no Pause or Resume (Delete, Edit and Run now stay). A paused recurring schedule still reads Paused and offers Resume.
