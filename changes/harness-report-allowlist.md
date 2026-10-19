---
packages: @parcha/agentrun-harness
kind: fix
---
A report page is read by allowlist, as a browser builds it. The recorder, the validator and the gate parse the page with parse5 (which replaces htmlparser2 as the harness's HTML dependency) and accept only an allowed set of elements and attributes: a namespaced or prefixed element, `svg`, `math`, `noscript`, `noembed`, `noframes`, `xmp` and any element outside the list are refused, as is any attribute outside the list (every `on*`, `srcdoc`, `formaction`, `xmlns:*`). Every `data-*` and `aria-*` attribute, `loading`, `decoding`, `role` and the `style` attribute are allowed, and a style attribute or element is read as CSS (no `url()` outside the report's files, no `data:` or `javascript:`, no `expression(`, `behavior` or `-moz-binding`).
