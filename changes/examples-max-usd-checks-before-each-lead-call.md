---
packages: repo
kind: fix
---
**The issue-triage example's `--max-usd` is checked before every lead request, not only on a timer**
- The cap was watched by a 250 ms timer alone, so a lead that answers quickly could start and finish many paid requests between two ticks, and a busy machine stretched the gap. The spend is now also read, as the spool stands, before each lead request (the lead's own and a research node's, including a retry), and no request is made once the known spend has reached the cap.
- The timer stays as the backstop that ends a request already in flight. The overshoot is at most that one request, which the stop message already says.
- The example's test bills its stub lead once per call instead of on a clock, and checks that the run ends within one call's cost of the cap.
