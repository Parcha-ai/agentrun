---
packages: @parcha/pi-durable-disk
kind: fix
---
**The self-fence watchdog starts in a host launched with `--input-type=module`**
- The watchdog's worker is eval'd CommonJS and inherited the host's Node flags. Under `--input-type=module` (a host that
  runs inline ESM through `-e` or stdin) Node read it as ESM, it threw `require is not defined`, and the run died at
  open. The worker now starts with no inherited flags (`execArgv: []`); it needs none of the host's.
