---
packages: repo
kind: ci
---
serve's tests read the fake docker's logs by whole lines only: a log just made and still empty, or a last line still being written, is no longer parsed, so the box default-image test no longer fails with "Unexpected end of JSON input" on a busy runner (F35). Its CI quarantine is lifted.
