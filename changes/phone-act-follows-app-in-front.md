---
packages: @parcha/agentrun-computer
kind: fix
---
A phone press that opens another app's page (Settings' "Search settings" opens Settings Intelligence's) now answers `changed` and that page's state. phoned read the act's own app's window before the new page reached the accessibility tree, so the act answered "unchanged" with the page on the screen. When the app in front after the steps is neither the one before them nor the act's, the act follows it, as after a nav step, and waits for its window within the settle.
