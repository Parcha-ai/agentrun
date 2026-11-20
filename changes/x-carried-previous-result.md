---
packages: @parcha/agentrun-serve, @parcha/agentrun-dsl
kind: feature
---
Over 32 KiB, a scheduled run is handed only the fields the producing run's schema names in `x-carried`; carried arrays lose entries from the front until they fit, and the run is told how many. A save refuses an `x-carried` that is not unique root property names. `submitParameters` leaves `x-carried` out of submit tool schemas.
