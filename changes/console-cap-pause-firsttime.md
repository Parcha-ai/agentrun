---
packages: repo
kind: fix
---
A run paused at its spend cap reads right the first time.
- Its status chip says "Paused at cap", not "Input required"; a run waiting on a tool call's approval says "Approval required", the approval card's own heading. Mission Control's Needs input count is unchanged.
- The run header shows what the run spent of its cap ("$0.52 est. of $0.60 cap", from the served `cost.cap_usd`), so after a raise it shows the new cap.
- While the run is paused, the header no longer offers a second "Raise the cap": the pause banner's raise is the one that continues it. If the pause comes without its own cap figure, that raise uses the run's served cap.
- Both raise forms say "A cap is a ceiling: the run is charged only for what it uses."
- On a phone held upright, the header's actions wrap instead of running off the screen's edge.
