---
packages: @parcha/pi-browser
kind: fix
---
`publicFetch` decodes a text page by the charset it declares, so a Latin-1 or Shift_JIS page reads as its words instead of U+FFFD. The charset is the Content-Type's `charset`, else (an HTML page) a `<meta charset>` or `<meta http-equiv="Content-Type">` in its first 1024 bytes, else UTF-8. A label no encoding goes by is passed over, and a `<meta>` naming UTF-16 reads as UTF-8, as a browser reads it. serve's default `web_fetch` reads pages through it.
