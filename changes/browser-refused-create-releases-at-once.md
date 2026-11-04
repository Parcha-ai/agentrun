---
packages: @parcha/pi-browser
kind: fix
---
A browser session the provider refuses to create (HTTP 401 or 403: a bad key, or a session type the account may not start) now ends released with `create_failed` as soon as the call fails, and the run's end no longer waits on it. Before, the refusal was treated like a create whose answer was lost: the record sat in `releasing` and a background release waited out the create deadline (60 s by default), so a run with a refused key read final about a minute after it completed. Every other failed create (a timeout, a 5xx, a dropped connection) still waits out the deadline, so a session that lands late is still released.
