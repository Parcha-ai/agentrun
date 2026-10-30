---
packages: @parcha/agentrun-serve
kind: ci
---
serve's codex tests now count only their own run's requests at their fake model gateway. Each test's gateway has a random key of its own, where every test once shared one literal. A request carrying another key is another process's, for example a proxy of another run still pointed at a port this test has since taken. It is refused and printed with its path, its model and a short prefix of its key, never counted as this run's. A request carrying the test's own key always counts, so a run whose own request gets past its cap still fails its test.
