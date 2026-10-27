---
packages: @parcha/pi-browser
kind: fix
---
`publicFetch`'s `maxBytes` must be a whole number of bytes above 0: a non-finite, negative, zero or fractional value throws a `RangeError` before any lookup, since one that is not a number would silently lift the cap.
