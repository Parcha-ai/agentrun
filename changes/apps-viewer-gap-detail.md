---
packages: repo
kind: feature
---
**`apps/viewer`: a credential gap says why**
- A browser session's `frame.gap` with reason `credential_on_page` carries its `detail` (`field`, `typed`, `too_deep`,
  `unreadable_frame` or `host`) into the picture, and the viewer shows it as the gap's tooltip: a credential or code
  field holds a value, held one since the last check, the page nests deeper than the check reads, a visible frame
  cannot be read, or the host paused the session. A detail it does not know is shown as it is.
