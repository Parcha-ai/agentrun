---
packages: @parcha/agentrun-serve
kind: fix
---
A synced folder's new sandbox, started in place of one its provider lost, no longer puts the whole folder back on the run's disk at the next changing call: the claim's sync goes on from the new sandbox's own listing. A loss that a sync finds now starts the new sandbox at the run's next call; before, that call failed on the lost one.

Two parts of the synced folder are gone. A run whose folder moves from an Archil mount to a synced folder (Daytona's `DAYTONA_ARCHIL_EGRESS` removed, or a provider moved to connect `dial`) keeps its files but not their modes. If a command made a link on the mount, the disk holds that link as an object a synced claim can't read, so the synced claim is refused; put the Archil setting back to go on with that run. A run that moves from a synced folder to an Archil mount loses the links and modes the synced claim recorded. A kept synced computer whose keep lapses is deleted without a read-back, so writes made while it was parked are lost. A kept computer that holds the run's folder another way than the resuming claim is not taken back: it is let go as one of another kind or provider is.
