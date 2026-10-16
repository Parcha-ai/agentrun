---
packages: repo
kind: feature
---
**`apps/viewer`: a message's text parts are kept apart, and a prompt's footer folds**
- `textOf` joined a message's text blocks with nothing, so a second text part (a footer a job adds after its prompt) ran
  into the first. Text parts are now joined with a blank line (`textPartsOf` gives them in order).
- The model turns panel shows the prompts (user messages) too: a prompt shows the start of its first text part, and
  everything else, the rest of that part and every later part (a footer after the prompt), folds whole under one
  "more"; a short prompt of one part is shown as it is.
