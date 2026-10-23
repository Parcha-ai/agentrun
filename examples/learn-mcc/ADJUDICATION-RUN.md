# Running the adjudication

ADJUDICATION.md is the protocol, frozen and pinned by sha256 before the first verdict. This file only says how to run it,
and changing it changes nothing in the method.

The runner is `examples/learn-classify/eval-adjudicate.mjs`, on the branch `asi/mcc-adjudicate` (M1's wiring of
`adjudicator-tools.mjs`). It writes `stage1.json`, `stage2.json` and `manifest.jsonl` under
`<out>/adjudication/<passId>/`, and pins in `meta.json`, before the first verdict, the sha256 of the sample's
commitments, the order salt, the candidates, the sample and the adjudicator home.

1. Candidates, once per round, over the teacher and every arm judged in it (each arm's scored DEV rows: `merchantId`,
   `mccAnswer`, `riskAnswer`):

   ```
   node examples/learn-mcc/adjudication.mjs candidates <adjudication.json> <order-salt> <candidates.json> \
     hand=<hand-dev-rows.jsonl> learn=<learn-dev-rows.jsonl>
   ```

2. The pass: first scripted at $0, then live under the TL's cap.

   ```
   node examples/learn-classify/eval-adjudicate.mjs --out <dir> --pass-id <id> --sample <adjudication.json> \
     --candidates <candidates.json> --commitments <adjudication-commitments.json> --order-salt <order-salt> --scripted
   node examples/learn-classify/eval-adjudicate.mjs ... --live --cap-usd 400 --model claude-opus-5-5 --thinking high
   ```

3. Unblind, once per arm, from the same stage files:

   ```
   node examples/learn-mcc/adjudication.mjs unblind <adjudication.json> <arm-dev-rows.jsonl> \
     <dir>/adjudication/<id>/stage1.json <dir>/adjudication/<id>/stage2.json <arm-out-dir>
   ```

4. The numbers (ADJUDICATION.md §6), with lanes/C1/ci.py:

   ```
   ci.py wilson K N                                                              # STRICT, ACCEPTABLE and the tier, per arm
   ci.py paired <hand-out>/learner.jsonl <arm-out>/learner.jsonl mccStrictRight  # against by hand
   ci.py paired <hand-out>/learner.jsonl <arm-out>/learner.jsonl mccAdjRight
   ```
