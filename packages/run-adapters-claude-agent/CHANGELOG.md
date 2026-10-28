# Changelog

## [Unreleased]

- A call the CLI turns down itself (a tool the session doesn't have, a built-in that is off) reaches the host as a failed call by its name, and only once the CLI's answer is in the session's store, as a tool's end is told once its outcome is. If that answer does not reach the store within `barrierMs`, the call is not shown and the adapter logs `a refused call is not shown`. A call the session's tool server ran is never taken for one the CLI turned down, whatever its error text, so it is heard once.
