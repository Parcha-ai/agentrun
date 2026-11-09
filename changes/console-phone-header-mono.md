---
packages: repo
kind: fix
---
On a phone (narrower than 640 px), the console's agent and run pages give their content more of the screen. The header, run box and tabs took 68% of a 390x844 screen on an agent's page, and 42% on a run's.
- **An agent's page.** The back button joins the name row, its word read but not shown. Edit shows its icon. The revision's facts fold into one line, which opens them; a description is cut at two lines until that line is opened, which shows it whole. The message box is one line high (a workflow's JSON input keeps its height). The effort's second line is hidden. Attach files is an icon in the row with Effort and Run, its limits in its title, with no drop zone.
- **A run's page.** The header is tighter. The title is smaller and cut at two lines (the whole of it in its title). The facts and the actions share one wrapping row.
- **Tabs.** They keep one row, with less padding.

640 px and up are unchanged.

Code and mono text in the console draw each character: ligatures are off for code, pre, kbd, samp, mono text, the caps labels and the workflow graph (`font-variant-ligatures: none`, `font-feature-settings: "liga" 0, "calt" 0`). `httpx==0.28.1` showed its `==` as one long bar.
