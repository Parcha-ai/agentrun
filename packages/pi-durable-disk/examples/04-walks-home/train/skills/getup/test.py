"""The get-up skill's test: a checkpoint passes when it does the skill in C MuJoCo, as the page will run it (skilltest.py)."""


def test(sim):
    times = [sim.rollout(seconds=6, start=s).righted_s() for s in ("left side", "right side", "back")]
    ok = all(t is not None for t in times)
    return ok, {"name": "slowest get-up", "value": max(times) if ok else None, "unit": "s", "target": "from left, right and back"}
