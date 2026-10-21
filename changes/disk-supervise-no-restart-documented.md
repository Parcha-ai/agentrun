---
packages: @parcha/pi-durable-disk
kind: docs
---
`supervise --no-restart` is in the usage text and the reference: it turns off the local driver's restart on failure (`localHost({ restart: false })`), so an instance that exits stays down until the supervisor's next pass.
