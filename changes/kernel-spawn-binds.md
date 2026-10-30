---
packages: @parcha/agentrun-kernel
kind: feature
---
`MachineSpawn.binds`: directories of the session's own a child reads and writes beyond the machine's. In a box they are bound read-write at their own paths into that child's box alone, as its homes, so the box's custody rules judge them like every home and the next child's box holds none of them. Each is checked before anything starts, in every mode, by its real path, and refused by name (`box_refused`) unless it is absolute and normalized, a directory of this user's own (never a link), under the session, and neither the session nor a directory holding one of its own.
