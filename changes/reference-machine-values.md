---
packages: repo
kind: feature
---
**Reference example: a fixture cut on a machine fails the check on that machine**
- `examples/reference/scan.ts` exports `machineValues()`, this machine's own values read when asked and never written
  anywhere: its host name and the short form before the first dot, its boot id (Linux's
  `/proc/sys/kernel/random/boot_id`, macOS's `kern.bootsessionuuid`), its home directory, and each of its addresses in
  100.64.0.0/10. A short or generic value is not taken: a name under 4 characters or `localhost`, a boot id under 16, a
  home directory of `/`. `machineValueIn(text, values)` finds one only as a whole token, never inside a longer name or
  number.
- `scripts/recording/machine-values.test.mjs` (so `npm run test:release` and `npm run check`) checks every committed
  recording and fixture (`apps/viewer/recordings`, `apps/viewer/test/fixtures`, `scripts/recording/fixtures`, every
  `fixtures/` and `recordings/` directory under `examples/`), and each `.jsonl` changed since the branch left
  `origin/main` when that ref exists, for those values and for the scanner's credential shapes. A finding names the file
  and the kind, never the value. On CI it checks the runner's own values.
