---
packages: @parcha/agentrun-serve
kind: fix
---
The console reads on a phone held sideways and in half a page. On a short screen (a phone at 844x390 or 932x430) the desktop sidebar gives way to the top bar and its menu, as in portrait, and a run's page scrolls as a whole, so a run waiting on a question shows the question, the Report and the Timeline in full instead of a body 0 px tall. Where a run's header is narrow (the Playground's Response panel at about 1500 px), the title keeps at least 16rem and its actions (Raise the cap, Stop, Cancel run, Archive) wrap onto their own row instead of squeezing it to a letter; the title shows two lines at most and its full text on hover.
