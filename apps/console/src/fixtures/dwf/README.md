# Decision-workflow fixtures (synthetic)

Unlike the recorded fixtures one folder up, these are written by hand: `GET /v2/runs/{id}/graph` did not exist when the
console's graph view was built. Serve answers it now, so these can be re-recorded from a live serve.

- `workflows.ts`: the five demo workflows in the DSL's v2 shape (batch-20, kyb, jury, doc-valid, merchant-mcc).
- `runs.ts`: graph answers. `batchRunAt(t)` is the 20-document batch `t` ms after its start (4 at a time; one broken PDF,
  one rate-limited call, one call whose outcome is unknown and so goes to review); `kybRun()` a KYB check with Parallel's
  citations and a route that took its unsure branch; `juryRun()` four decision models that disagree.
- `pages.ts`: the certificate page images, drawn as SVG data URLs (one altered, one without a seal, one faint).

Every company, file number, official, source URL (`.example` hosts), cost and latency is invented.
