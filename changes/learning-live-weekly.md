---
packages: repo
kind: ci
---
Learning's live checks run on real models every Monday and on demand (`Learning live weekly`, never on a pull request): the grader on the held-out eval set over three grade models (`learn-eval.mjs --set heldout --grade-models`), and one seed of the learning bench on pi (`learn-bench.mjs`). Each has a hard dollar cap, results are kept as an artifact, and the summaries are the run's job summary. It runs only where the repository has the secrets `LEARNING_LIVE_MODEL_BASE_URL` and `LEARNING_LIVE_MODEL_API_KEY` and the variables `LEARNING_LIVE_MODEL` and `LEARNING_LIVE_GRADE_MODELS`; elsewhere its summary says which are missing. `learn-eval.mjs` takes `--max-usd`: it sends no further model request once its spend reaches the cap, or once a request's cost can't be read, and exits 3. Upgrading: nothing to do.
