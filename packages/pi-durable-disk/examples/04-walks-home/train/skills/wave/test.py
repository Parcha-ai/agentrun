"""The wave skill's test: a checkpoint passes when it does the skill in C MuJoCo, as the page will run it (skilltest.py)."""


def test(sim):
    r = sim.rollout(seconds=10)
    up = r.share(r.feet_height[:, 0] > 0.08, after_s=2)  # the first foot held up, after the first 2 s
    ok = r.fell_at is None and up >= 0.6 and r.total_mps() <= 0.15
    return ok, {"name": "paw up", "value": round(up, 2), "unit": "share of time", "target": ">= 0.6"}
