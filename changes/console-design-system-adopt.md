---
packages: repo
kind: feature
---
Every console page is on the design system, and a test keeps it there. Text sizes are the type scale's steps, colours and layers are tokens, and buttons, fields, tabs, the navigation, error boxes and the connection strip are the shared primitives; `src/design-system.sources.test.ts` fails a line that writes a literal colour, a size off the scale or a hand-built control, and says what to write instead. What you see change: the sign-in page follows the light or dark theme instead of being always dark; orange text and icons are the darker `primary-text` in the light theme, so they pass 4.5:1; every field has an edge that is 3:1 against the page and takes the focus ring; a read that failed shows in one error banner with its Try again button; tabs move with the arrow keys; a page image opens in a dialog that holds the keyboard and has a Close button.
