---
packages: repo
kind: ci
---
serve's daytona-boxes test that run A's token reaches nothing of run B's box no longer fails when run B makes a call of its own at the same moment (a late call at its turn's end). Run A's calls now name a file only they name, and the test looks for that name in what reached run B's box. Run A's own box, asked the same way, shows the name is seen when a call does get through.
