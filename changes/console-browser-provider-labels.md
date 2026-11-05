---
packages: repo
kind: fix
---
The browser's provider choice, in Settings → Tools and in an agent's editor, names and explains the browser's providers: "Auto (Browserbase where its key is saved, else Kernel)", "Browserbase", "Kernel" and "Local Chrome", each with a line on what it needs. It read them through the names web_search and web_fetch share, so Kernel read "kernel fetch" with the guarded fetch's help, auto took search's rule, and Browserbase and chrome showed their ids. What the browser resolves to reads by the same names. Search's and fetch's names and help are unchanged.
