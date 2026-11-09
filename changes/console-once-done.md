---
packages: repo
kind: fix
---
A one-time schedule that has run (a one time, a last firing, and no next time, as served) reads "Done · ran <when>" on the Triggers list and its page, with no Pause or Resume (Delete, Edit and Run now stay). A paused recurring schedule still reads Paused and offers Resume.
