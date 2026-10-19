---
packages: repo
kind: fix
---
On fakes, the vision agent's scripted lead looks at a first file that is a still image (PNG, JPEG, WebP or GIF) as it is, and cites the image itself. Before, it read any file that was not a PDF as a film and asked for its frame at second 1, which a still image does not have, so a free `examples/lake-mead` run stopped with "the model did not answer". PDFs and films are read as before.
