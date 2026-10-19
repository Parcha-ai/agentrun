---
packages: @parcha/pi-vision
kind: fix
---
A derivation kept in the derive directory (a PDF's text, a rendered page) is used again only when it holds the bytes this process kept there. The directory is shared with whatever runs in the environment, so a file written or changed there by anything else is no longer taken as the document's text or the page's image: the derivation is made again from the source and kept again. A file an earlier process left is made again once, after a restart, and used again from then on.
