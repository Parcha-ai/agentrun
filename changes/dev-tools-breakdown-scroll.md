---
packages: @parcha/agentrun-serve
kind: fix
---
The console's Dev tools tab no longer scrolls the whole page on its Breakdown view. The switch beside the per-request chart has hidden radio inputs that were positioned against the page instead of the tab's own scrolling section, so on a long breakdown the page grew a second scrollbar and showed empty space under the message box. The tab's scrolling panes now hold their own out-of-flow content, and only the section scrolls.
