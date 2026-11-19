---
packages: @parcha/agentrun-serve
kind: fix
---
A synced folder's new sandbox, started in place of one its provider lost, no longer puts the whole folder back on the run's disk at the next changing call: the claim's sync goes on from the new sandbox's own listing. A loss that a sync finds now starts the new sandbox at the run's next call; before, that call failed on the lost one.

Two parts of the synced folder are gone. A run whose folder moves from a synced folder to an Archil mount loses the modes and links the synced claim recorded: the mount never reads sync.json. A kept synced computer whose keep lapses is deleted without a read-back, so writes made while it was parked are lost. A kept computer that holds the run's folder another way than the resuming claim is not taken back: it is let go as one of another kind or provider is.
