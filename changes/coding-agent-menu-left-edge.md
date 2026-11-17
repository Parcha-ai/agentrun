---
packages: @parcha/agentrun-serve
kind: fix
---
The console's coding-agent menu (Connect agent, Build an agent, Run agent and the like) opens under its control from the control's left edge. It was placed by the chevron's right edge, so a control narrower than the 240 px menu, near the left of the page, pushed the menu left of the control and over the navigation. Where the left edge would leave the viewport (a control at the right of a toolbar), the menu still opens from the control's right edge.
