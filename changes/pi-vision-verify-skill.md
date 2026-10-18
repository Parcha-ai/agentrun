---
packages: @parcha/pi-vision
kind: feature
---
The `verify` skill: whether a PDF has each mark a checklist names (a seal, a signature, a stamp, a number, two numbers that must agree), answered yes or no with the mark's box on its page, cited as `file.pdf#page=N&xywh=percent:x,y,w,h`. The checklist is a JSON file (the kinds of page, and per mark a short name, its question, its box and what it looks like when it is there), so another kind of document is another file, not other code. Two code-mode programs: every page rendered through its crop box (the page PDF.js and other viewers show, so a box in percent of the render is a box in percent of the page) and one `vision.judge` request a page for its kind and each mark's noul and box; then each mark kept from the page where Jev is surest, its box only when the noul says it is there, two marks that must agree cut out larger and asked side by side, and a yes-or-no table. No new function.
