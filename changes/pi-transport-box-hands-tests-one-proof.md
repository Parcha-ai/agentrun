---
packages: @parcha/pi-transport
kind: ci
---
pi-transport's box and hands tests drop the cases another test already runs on the same path, the tests of test helpers, and two waits or checks that could not fail for the reason they name. Gone, with what still proves each:
- Box cases the conformance suite runs on the same registration: the local label refusal (the conformance label case), and the receipt of a box with no price (`box-receipts.test.ts`).
- A local watchdog case, folded into the expiry case, which now also ends a program that cleared its environment.
- In the hosted sandbox provider's tests, a case for odd probe output, folded into the facts case, and an env case whose behaviour the fake itself supplied (the sandbox-env case and the conformance suite on that registration remain).
- The tests of the hosted sandbox provider's live suites' label helper, and of `waitNotRunning`'s positive path and bound; that helper's negative controls stay, and every leak guard calls it.
- Two benchmarks with no assertion in live files no job runs.

Repaired: Daytona's environment check plants Daytona's own variables and checks that no request or box carries them, and that a provider given no URL sends every request to the built-in one, in place of a source grep. The hands pool's receipts are counted per case against the boxes it made, so a ledger that receipts one box of several fails. The release-during-command case waits for the command to run, not 500 ms.
