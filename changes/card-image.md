---
packages: @parcha/agentrun-serve
kind: feature
---
The console draws a share card as an image: one renderer for every picture card, a free run's receipt and each Wrapped card among them. A card says only the words and numbers its caller gives it: an eyebrow, a title, one big figure, up to six label and value rows, up to two bar charts (columns for hours, days or months; labelled rows for shares), and a footnote. It comes out as a 1200 by 675 SVG and the same image as a data URL an `<img>` shows, dark unless asked for light. Every colour is a console design token, the fonts are the console's with the system's after them, and the image loads nothing: no font, no picture, no style sheet. In the browser it can also be drawn as a PNG for a download.
