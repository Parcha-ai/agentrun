---
packages: repo
kind: feature
---
**Reference example: a fixture cut on a machine fails the check on that machine**
- `examples/reference/scan.ts` exports `machineValues()`, this machine's own values read when asked and never written
  anywhere: its host name and the short form before the first dot, its boot id (Linux's
  `/proc/sys/kernel/random/boot_id`, macOS's `kern.bootsessionuuid`), its home directory, and each of its addresses in
  100.64.0.0/10. A value that names nothing of its own is not taken: a name under 4 characters or `localhost`, a boot id
  under 16, a home directory every machine shares (`/`, `/root`, `/var/root`; `/root` is also where a workflow's
  execution paths start). `machineValueIn(text, values)` finds one only whole: a name, boot id or address goes on through
  a hyphen, and through a dot with more of a name after it (`build` is not in `build-agent` or `ci.build`); a home
  directory may have a path after it, never a longer name.
- `scripts/recording/machine-values.test.mjs` (so `npm run test:release` and `npm run check`) checks every committed
  recording and fixture (`apps/viewer/recordings`, `apps/viewer/test/fixtures`, `scripts/recording/fixtures`, every
  `fixtures/` and `recordings/` directory under `examples/`), and each `.jsonl` changed since the branch left
  `origin/main`, committed, staged or never staged, when that ref exists (git's names read NUL-separated), for those
  values and for the scanner's credential shapes. A finding names the file and the kind, never the value. On CI it
  checks the runner's own values.
