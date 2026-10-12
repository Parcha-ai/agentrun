"""The spin skill's test: a checkpoint passes when it does the skill in C MuJoCo, as the page will run it (skilltest.py)."""


def test(sim):
    r = sim.rollout(seconds=10)
    rate = r.yaw_rate()
    ok = r.fell_at is None and abs(rate) >= 1.0 and r.total_mps() <= 0.2  # turning in place, not walking a circle
    return ok, {"name": "spin rate", "value": round(rate, 3), "unit": "rad/s", "target": ">= 1.0"}
