---
packages: @parcha/agentrun-computer
kind: fix
---
On a phone, a press that opens another package's page (Settings' "Search settings" opens Settings Intelligence's "Settings Suggestions") now answers what happened: the step `semantic, verified`, the act `changed`, and an act with `observe: true` shows the new page in front. Before, the act failed with `Settings has no window on the screen (…): open it with apps.launch first`, so the agent was told a press that worked had failed; without `observe` the step answered unverified.
- The surface's look after an act follows the daemons' rule for the window an act finished on: the act's app's window while it shows one, else the window in front. This holds on every computer with the ui group.
- phoned verifies a step after which another app is in front (neither the one before the step nor the act's) against that app's window, once it shows, within the act's settle limit. The app in front changing alone verifies nothing: its window must show.
