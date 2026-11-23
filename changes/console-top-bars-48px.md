---
packages: @parcha/agentrun-serve
kind: fix
---
Console: the Settings tab row and the strips across the top of every page (demo mode, a lost or resumed connection) are 48px tall, like every page's top bar, so their bottom edge meets the edge under the logo row in the navigation. They were 44 to 45px, and the two lines stepped where they met.
