---
packages: repo
kind: fix
---
A schedule's cron line reads in words on the Triggers list and on its page: "0 8 * * 1" in UTC reads "At 08:00, only on Monday · UTC", by cronstrue on a 24-hour clock, with the raw line as the words' tooltip and in the editor. One cronstrue can't read stays as it is ("Cron <line>"). Its next time beside it is unchanged.
