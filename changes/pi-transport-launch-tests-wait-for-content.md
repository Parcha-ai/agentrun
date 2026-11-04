---
packages: repo
kind: ci
---
pi-transport's launch tests now wait for a file's text, not only for the file, when the program writes that file through a shell redirect. The shell creates the file empty before the command writes it, so a test that polled until the file existed could read it empty. It then failed (`expected '' to be '<hash>'`), or checked an empty environment and passed on nothing. The waits for the hash of the program's stdin and secrets, its environment, its uid and its pid, and for the watchdog's pid, now wait until the file has text. The frame tests wait for the last file the second incarnation writes before they read the others. Test-only: the launcher and the box code are unchanged.
