---
packages: repo
kind: feature
---
**Reference example: the scanner refuses private addresses, a run's secret values and this machine's host name**
- The one scanner (`examples/reference/scan.ts`) refuses loopback and private-network endpoints (127/8, 10/8,
  172.16/12, 192.168/16, 169.254/16, `::1`, fc00::/7, fe80::/10), so the recorder, the validator and the hosted
  gallery's gate all refuse them.
- The recorder also refuses the exact value of each secret env var the demo names (`finishRecording(dir, header,
  { secrets })`; `run.ts` passes every env name `demo.json` lists under `keys`), raw or behind a JSON escape, and this
  machine's host name and its first label. The values are read from the environment at record time and kept only in
  memory; an error names a secret by its env name, never its value. A value under 8 characters is not scanned for, and
  one stderr line names its env var.
