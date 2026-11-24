---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: fix
---
A ChatGPT sign-in reads signed in once it is saved, while the server still relists what it offers. A pasted sign-in that a sign-out, a newer start or the 10 minutes cut off says so, in the words Settings shows, never that the log says why. A sign-out whose relist fails still signs out. A relist that failed is taken again at the next read, even when an earlier one finished after it, and reads at once relist once.

`agentrun start` keeps the server's line of a ChatGPT sign-in that did not finish in `start.log`, its authorize code whole; the terminal still says a code the authorize step never sends as `authorize_other`.

The share card's alt text reads at most 365 bars of a chart, then how many more there are.
