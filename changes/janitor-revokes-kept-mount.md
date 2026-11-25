---
packages: @parcha/agentrun-serve
kind: fix
---
A kept computer that the janitor ends now has its run folder's mount credential revoked, on the disk recorded at the park, even when the run was deleted since. Before, a run stopped while parked, or resumed with its computer off, left that credential valid for up to 24 hours. A revoke that keeps failing is retried until the credential has expired, then the computer's record is closed.
