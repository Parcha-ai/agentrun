---
packages: @parcha/agentrun-serve
kind: ci
---
serve's test of a workflow run ending while another connection holds the agent store now decides when the run ends. Its model node answers once the test makes a file, which the test does after it takes the hold, and the test lets the store go once the run's end has been refused 21 times, 100 ms apart: more than a request's 2 s wait. Before, the run ended on the faux model's 1.5 s timer and the store was held for a fixed 4.5 s from whenever the timeline first said `working`. On a loaded machine the run's end could come after the hold was let go, so the test failed although the server behaved right.
