---
packages: repo
kind: fix
---
Code and mono text in the console draw each character: ligatures are off for code, pre, kbd, samp, mono text, the caps labels and the workflow graph (`font-variant-ligatures: none`, `font-feature-settings: "liga" 0, "calt" 0`). `httpx==0.28.1` showed its `==` as one long bar.
