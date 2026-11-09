---
packages: repo
kind: fix
---
A one-time schedule that has run (a one time with no next time, whose last firing is for that time and started a run, as served) reads "Done · ran <when>" on the Triggers list and its page, with no Pause or Resume (Delete, Edit and Run now stay). A paused recurring schedule still reads Paused and offers Resume. A one time whose time passed with no run known to have started reads "Its time passed · <when>" and keeps Resume (only the server's started firing hides it, never the browser's clock alone); one run by hand after it was done still reads Done on its page.
