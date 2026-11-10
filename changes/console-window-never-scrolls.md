---
packages: repo
kind: fix
---
The console's window no longer scrolls away from its sidebar. On Settings → Keys the whole page could scroll past the window, leaving the sidebar cut short over blank space: text kept for a screen reader alone was placed in the document and stretched it. The console's outer box and its page box now hold what is positioned inside them, on every page, so the only scrollbar is the page's own.
