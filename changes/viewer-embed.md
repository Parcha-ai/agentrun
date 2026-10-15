---
packages: repo
kind: feature
---
**`apps/viewer`: embed mode**
- `&embed=1` frames the viewer in another page: no header (a recording that breaks the format still says so), the full
  width of its frame, and each time the point enters a chapter a `postMessage` of that chapter alone,
  `{ source: "agentrun-viewer", type: "chapter", title, stop }`, to the framing page's origin when the browser gives it
  (an http or https page), else to any. The viewer acts on no message it is sent.
