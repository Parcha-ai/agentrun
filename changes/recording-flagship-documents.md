---
packages: repo
kind: feature
---
**A recording can carry a training run's documents, and the validator checks them (draft 55)**
- `apps/viewer/RECORDING.md` adds six durable documents a run's tools write through the session's store: `train.progress`, `train.render`, `train.checkpoints`, `train.sweeps`, `body.design` and `learn.curve`. Each value is a flat record with one `basis` (`measured`, `scripted`, `unmeasured`, `agent`, `simulated` or `reported`; missing reads as unmeasured). A `place` holds only `environment`, `kind`, `host` and `box`, and a curve point `[x, null]` is a gap. A panel prints a number's basis beside it.
- `scripts/recording/validate.mjs` (with `scripts/recording/flagship.mjs`) refuses a document that breaks its shape, has a basis outside the enum, has a `measured` reward, score or curve `y` without its unit, or has a non-finite number. It also refuses a blob that is not a file of an allowed extension, a conversation, thread or checkpoint the recording does not hold, any `place` field beyond the four, and a `place.host` or `place.box` that is not a label the recording itself gave.
