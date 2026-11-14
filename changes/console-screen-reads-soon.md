---
packages: @parcha/agentrun-serve
kind: fix
---
The console's Screen tab shows who drives and the first frame when they happen. It used to show them up to 3 s late. It read the run's computer every 3 s, so the header kept saying "Yours after the agent's step" for up to 3 s after the viewer said "you have the computer". A hand-back's answer, read before the run applies it, kept "You drive" up as well. Measured live on E2B and Agent37, the header followed the viewer by 1.6 to 3.3 s. The tab now reads again every 400 ms while a change is on its way: while the screen is being opened, while a take-over waits for the agent's step, and for 4 s after the page's own take-over or hand-back. Otherwise it keeps reading every 3 s. A take-over's or hand-back's answer reaches the tab when it comes, no longer after the run's re-read that follows it. An ask's Done and Cancel stay off once the answer is taken, until that re-read takes the card away.
