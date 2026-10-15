---
packages: @parcha/pi-durable-disk
kind: fix
---
`daytonaHost` accepts a package installed with npm: a box path may contain `@`, so `packageDir: "/opt/app/node_modules/@scope/pkg"` (and the launcher inside it) is a plain absolute path. It was refused as `INVALID_ARGUMENT`. A path with a `..` segment is now refused too; the old pattern let `/opt/../etc` through.
